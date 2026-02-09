"""
Inference Client
HTTP client for calling persistent LLM inference servers.
"""
import requests
import logging
import os
from typing import Optional, List

logger = logging.getLogger(__name__)


class EmptyModelResponseError(RuntimeError):
    """
    Raised when the server returns HTTP 200 but an empty {"text": ""} payload.
    This is never a valid completion; it's typically a server-side bug or a stale server process.
    """

    def __init__(
        self,
        message: str,
        *,
        server_url: str,
        status_code: Optional[int],
        response_json: Optional[dict],
        prompt_len: int,
        max_new_tokens: int,
        temperature: float,
    ):
        super().__init__(message)
        self.server_url = server_url
        self.status_code = status_code
        self.response_json = response_json
        self.prompt_len = prompt_len
        self.max_new_tokens = max_new_tokens
        self.temperature = temperature


class InferenceClient:
    """HTTP client for LLM inference server"""
    
    def __init__(self, base_url: str):
        """
        Initialize inference client.
        
        Args:
            base_url: Base URL of the inference server (e.g., "http://127.0.0.1:9100")
        """
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
        # Default generation timeout can be too low for big models on cold start.
        # Override with INFERENCE_HTTP_TIMEOUT_SECONDS if needed.
        try:
            self.timeout_seconds = int(os.getenv("INFERENCE_HTTP_TIMEOUT_SECONDS", "900"))
        except Exception:
            self.timeout_seconds = 900
    
    def generate(
        self, 
        prompt: str, 
        max_new_tokens: int = 10000, 
        temperature: float = 0.7,
        images: Optional[List[str]] = None,
    ) -> str:
        """
        Generate text from prompt.
        
        Args:
            prompt: Input prompt text
            max_new_tokens: Maximum number of tokens to generate
            temperature: Sampling temperature (0.0 = greedy, higher = more random)
            
        Returns:
            Generated text (clean, no wrappers)
            
        Raises:
            requests.exceptions.RequestException: If request fails
            ValueError: If server returns invalid response
        """
        url = f"{self.base_url}/generate"
        
        payload = {
            "prompt": prompt,
            "max_new_tokens": max_new_tokens,
            "temperature": temperature
        }
        if images is not None:
            payload["images"] = images
        
        logger.debug(f"Sending generation request to {url}")
        logger.debug(f"Prompt length: {len(prompt)} chars")
        logger.debug(f"Max tokens: {max_new_tokens}, Temperature: {temperature}")
        
        try:
            response = self.session.post(
                url,
                json=payload,
                timeout=self.timeout_seconds
            )
            response.raise_for_status()
        except requests.exceptions.Timeout:
            raise TimeoutError(
                f"Generation request timed out after {self.timeout_seconds}s. "
                f"Model may be too slow or unresponsive."
            )
        except requests.exceptions.HTTPError as e:
            # Extract error detail from FastAPI error response
            error_detail = None
            try:
                error_json = response.json()
                if "detail" in error_json:
                    error_detail = str(error_json["detail"])
            except Exception:
                pass
            
            # Use server's error detail if available, otherwise use the HTTP error message
            if error_detail:
                logger.error(f"Generation failed: {error_detail}")
                raise RuntimeError(error_detail) from e
            else:
                logger.error(f"Generation request failed: {e}")
                raise RuntimeError(f"Server returned {response.status_code}: {str(e)}") from e
        except requests.exceptions.RequestException as e:
            logger.error(f"Generation request failed: {e}")
            raise
        
        # Parse response
        try:
            result = response.json()
        except ValueError as e:
            raise ValueError(f"Invalid JSON response from server: {e}")
        
        # Extract text from response
        if "text" not in result:
            logger.error(f"Server response missing 'text' field. Full response: {result}")
            raise ValueError(f"Server response missing 'text' field: {result}")
        
        text = result["text"]
        logger.debug(f"Generated text length: {len(text)} chars")

        # Never treat an empty response as success. This typically means:
        # - generation failed but server returned "" (bug - server should raise HTTPException)
        # - model immediately stopped / produced 0 tokens
        # - OOM/other runtime error was swallowed upstream
        if text is None or str(text).strip() == "":
            # Log the full response for debugging
            logger.error(f"Server returned empty text. Full response: {result}")
            logger.error(f"Request was: prompt length={len(prompt)}, max_new_tokens={max_new_tokens}, temperature={temperature}")
            
            # Check if server returned 200 OK (bug) vs 500 (expected)
            status_code = getattr(response, 'status_code', None)
            # IMPORTANT: don't use .format() with function calls in placeholders.
            # Build the message explicitly to avoid KeyError like "{len(prompt)}".
            error_msg = (
                "Model returned an empty response. This is not a valid completion.\n\n"
                "This indicates the model produced no output. Possible causes:\n"
                "  • Model stopped generation immediately (0 new tokens)\n"
                "  • All output tokens were special tokens (EOS/PAD) that were stripped\n"
                "  • Model ran out of VRAM and silently failed\n"
                "  • Tokenizer/template issue causing immediate stopping\n\n"
                "If you recently updated the code, make sure the persistent server process restarted.\n"
                "A server running old code can incorrectly return HTTP 200 with {\"text\": \"\"}.\n\n"
                f"Diagnostics:\n"
                f"  • request: prompt_len={len(prompt)}, max_new_tokens={max_new_tokens}, temperature={temperature}\n"
                f"  • server_status={status_code}\n"
                f"  • raw_response={result}\n"
            )
            
            raise EmptyModelResponseError(
                error_msg,
                server_url=self.base_url,
                status_code=status_code,
                response_json=result if isinstance(result, dict) else None,
                prompt_len=len(prompt),
                max_new_tokens=max_new_tokens,
                temperature=temperature,
            )

        return text
    
    def health_check(self) -> bool:
        """
        Check if server is healthy.
        
        Returns:
            True if healthy, False otherwise
        """
        try:
            response = self.session.get(f"{self.base_url}/health", timeout=2)
            return response.status_code == 200
        except Exception:
            return False
    
    def close(self):
        """Close the session"""
        self.session.close()
    
    def __enter__(self):
        """Context manager entry"""
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        self.close()
