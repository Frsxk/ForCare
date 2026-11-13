import type { Metadata } from "next";
import { HomecareBookingFlow } from "@/components/homecare-booking-flow";

export const metadata: Metadata = { title: "Pesan Homecare | ForCare" };
export default function Page() { return <HomecareBookingFlow />; }
