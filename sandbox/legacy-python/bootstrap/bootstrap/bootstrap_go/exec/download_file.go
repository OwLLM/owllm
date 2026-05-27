// download_file: HTTPS download of a single artifact.
//
// Args (model-provided):
//   url:     URL (required, must be https unless LOCALLLM_ALLOW_HTTP=1)
//   dest:    target filesystem path (required)
//   sha256:  optional hex-encoded SHA-256 to verify after download
//
// Idempotence: if `dest` already exists and matches sha256 (when given),
// skip the download. Otherwise overwrite atomically (.part -> dest).
//
// Why not pull in a hardened HTTP library: we want a small static
// binary. The stdlib net/http is enough for one-shot downloads to
// trusted hosts (model GGUFs, llama.cpp release zips, pip wheels).
package exec

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ruigro/LLM-Studio/LLM/bootstrap/bootstrap_go/plan"
)

// DownloadFileOpts allows tests to inject a custom HTTP client.
type DownloadFileOpts struct {
	HTTPClient *http.Client
}

// DownloadFile fetches s.Args["url"] to s.Args["dest"], verifying
// SHA-256 when supplied. Returns nil on success.
func DownloadFile(opts DownloadFileOpts, s plan.Step) error {
	rawURL, err := argRequired(s.Args, "url")
	if err != nil {
		return fmt.Errorf("download_file: %w", err)
	}
	dest, err := argRequired(s.Args, "dest")
	if err != nil {
		return fmt.Errorf("download_file: %w", err)
	}
	wantHash, _ := argString(s.Args, "sha256")

	if err := validateURL(rawURL); err != nil {
		return fmt.Errorf("download_file: %w", err)
	}

	// Skip if the destination already matches the expected hash.
	if wantHash != "" {
		if existing, err := sha256File(dest); err == nil &&
			strings.EqualFold(existing, wantHash) {
			log.Printf("  download_file: %s already up-to-date (sha256 match)", dest)
			return nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return fmt.Errorf("download_file: mkdir %s: %w", filepath.Dir(dest), err)
	}

	tmp := dest + ".part"
	defer os.Remove(tmp) // best-effort if we error out partway

	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Minute}
	}
	resp, err := client.Get(rawURL)
	if err != nil {
		return fmt.Errorf("download_file: GET %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download_file: GET %s -> HTTP %d", rawURL, resp.StatusCode)
	}

	out, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("download_file: create %s: %w", tmp, err)
	}

	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(out, hasher), resp.Body)
	closeErr := out.Close()
	if err != nil {
		return fmt.Errorf("download_file: write %s: %w", tmp, err)
	}
	if closeErr != nil {
		return fmt.Errorf("download_file: close %s: %w", tmp, closeErr)
	}
	log.Printf("  download_file: wrote %.1f MB to %s", float64(written)/1e6, dest)

	if wantHash != "" {
		got := hex.EncodeToString(hasher.Sum(nil))
		if !strings.EqualFold(got, wantHash) {
			return fmt.Errorf("download_file: sha256 mismatch (want %s, got %s)",
				wantHash, got)
		}
	}

	if err := os.Rename(tmp, dest); err != nil {
		return fmt.Errorf("download_file: rename %s -> %s: %w", tmp, dest, err)
	}
	return nil
}

func validateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" && os.Getenv("LOCALLLM_ALLOW_HTTP") == "1" {
		return nil
	}
	return fmt.Errorf("only https URLs are allowed (got %q)", u.Scheme)
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
