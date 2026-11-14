import type { Metadata } from "next";
import { LoginPage } from "@/components/login-page";

export const metadata: Metadata = { title: "Masuk | ForCare" };

export default function Login() {
  return <LoginPage />;
}
