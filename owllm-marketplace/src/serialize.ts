import type { User } from './db.js';
import type { Config } from './config.js';

export function serializeUser(user: User, config: Config) {
  return {
    github_id: user.github_id,
    github_login: user.github_login,
    email: user.email,
    is_creator: Boolean(user.is_creator),
    is_admin: config.adminGitHubIds.has(user.github_id),
  };
}
