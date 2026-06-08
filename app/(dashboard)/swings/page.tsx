import { redirect } from "next/navigation";

// Legacy route — "Telemetry Logs" moved to /telemetry
export default function SwingsPage() {
  redirect("/telemetry");
}
