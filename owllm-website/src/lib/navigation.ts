export interface NavLink {
  label: string;
  href: string;
}

export const NAV_LINKS: NavLink[] = [
  { label: "Home", href: "/" },
  { label: "Features", href: "/features" },
  { label: "Use cases", href: "/use-cases" },
  { label: "Download", href: "/download" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
];
