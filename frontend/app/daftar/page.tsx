import type { Metadata } from "next";
import { RegisterPage } from "@/components/auth-pages";

export const metadata: Metadata = { title: "Daftar | ForCare" };
export default function Page() { return <RegisterPage/>; }
