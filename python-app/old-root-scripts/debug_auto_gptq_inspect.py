import pkgutil
import auto_gptq

print("auto_gptq file:", auto_gptq.__file__)
mods = [m.name for m in pkgutil.walk_packages(auto_gptq.__path__, auto_gptq.__name__ + ".")]
print("config-like modules:", [n for n in mods if "config" in n.lower()][:200])

