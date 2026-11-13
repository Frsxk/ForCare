import type { Metadata } from "next";
import { LoginPage } from "@/components/auth-pages";

export const metadata: Metadata = { title: "Masuk | ForCare" };
export default function Page() { return <LoginPage/>; }
