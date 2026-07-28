"""Role definitions — YAML-defined personas and tool allowlists."""
from core.agents.roles.loader import (
    Role,
    builtin_roles,
    load_role,
    load_roles_dir,
)

__all__ = ["Role", "builtin_roles", "load_role", "load_roles_dir"]
