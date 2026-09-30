import type { Metadata } from "next";
import { CallPanel } from "@/components/call/call-panel";
import { SayThis } from "@/components/call/say-this";
import { DEMO_CLINIC } from "@/lib/clinic/config";

export const metadata: Metadata = {
  title: "Call the demo clinic",
  description:
    "Talk to Twiceheard's intake agent in the browser. It collects what a clinic needs before a visit, reads every critical detail back, and books an appointment.",
};

export default function CallPage() {
  return (
    <article className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold">Call the demo clinic</h1>
        <p className="max-w-2xl text-[var(--muted)]">
          This is the same agent that answers the clinic&apos;s phone. It asks for your name, date
          of birth, a phone number, why you are coming in, medications and allergies, then offers
          appointment times. Every critical detail is read back to you before it is recorded.
        </p>
      </header>
      <SayThis />
      <CallPanel clinicId={DEMO_CLINIC.id} clinicName={DEMO_CLINIC.name} />
    </article>
  );
}
