from transformers import AutoTokenizer
from pathlib import Path

model_dir = Path(r"C:\1_Git\LocaLLM\LLM\models\TheBloke__deepseek-coder-33B-instruct-GPTQ")
tok = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)

print("HAS_TEMPLATE", bool(getattr(tok, "chat_template", None)))
tpl = getattr(tok, "chat_template", None) or ""
print("TEMPLATE_HEAD", tpl[:400])
print("BOS_ID", tok.bos_token_id, "EOS_ID", tok.eos_token_id, "PAD_ID", tok.pad_token_id)

prompt = "Write a Python function that adds two numbers."
messages = [{"role": "user", "content": prompt}]
formatted = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
print("FORMATTED_HEAD", formatted[:200].replace("\n", "\\n"))

for add_special in (False, True):
    enc = tok(formatted, return_tensors=None, add_special_tokens=add_special)
    ids = enc["input_ids"]
    last = ids[-1] if ids else None
    print("ENC", "add_special_tokens=", add_special, "len=", len(ids), "last_id=", last, "last_is_eos=", (last == tok.eos_token_id))

gen_cfg_path = model_dir / "generation_config.json"
print("GEN_CFG_EXISTS", gen_cfg_path.exists())
if gen_cfg_path.exists():
    print("GEN_CFG_HEAD", gen_cfg_path.read_text(encoding="utf-8")[:1000])

