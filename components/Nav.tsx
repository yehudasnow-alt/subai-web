"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
export default function Nav() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => { setUser(data.user || null); setLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => { setUser(session?.user || null); });
    return () => { listener.subscription.unsubscribe(); };
  }, []);
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split("@")[0] || "";
  const initials = name ? name.charAt(0).toUpperCase() : "U";
  return (
    <nav className="nav-glass">
      <Link href="/" className="nav-logo">
        <img src="/icons/subai-logo.webp" alt="SubAI" style={{ height: 36, objectFit: "contain" }} />
      </Link>
      <div className="nav-links">
        <a href="/#features">יתרונות</a>
        <a href="/#pricing">מחירים</a>
        {loading ? null : user ? (
          <>
            <Link href="/dashboard" style={{ fontWeight: 600, color: "#6366f1" }}>האזור שלי</Link>
            <Link href="/dashboard" className="nav-user-pill">
              <div className="nav-avatar">{initials}</div>
              <span className="nav-email">{name}</span>
            </Link>
          </>
        ) : (
          <Link href="/auth" className="nav-cta">התחל בחינם</Link>
        )}
      </div>
    </nav>
  );
}
