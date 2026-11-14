import Link from "next/link";

export function AuthBrandWordmark() {
  return (
    <Link href="/login" className="auth-brand" aria-label="ForCare">
      <span className="auth-brand-wordmark">
        <span className="auth-brand-wordmark-for">For</span>
        <span className="auth-brand-wordmark-care">Care</span>
      </span>
    </Link>
  );
}
