"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function Header() {
  const [user, setUser] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((me) => {
      setUser(me?.user ?? null);
      if (me === null && pathname !== "/login") router.replace("/login");
    });
  }, [pathname, router]);
  return (
    <header>
      {user !== null && <span data-testid="user-menu">{user}</span>}
      <nav aria-label="Hauptnavigation"><Link href="/">Tickets</Link> <Link href="/info">Info</Link></nav>
    </header>
  );
}
