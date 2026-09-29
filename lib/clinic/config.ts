import { z } from "zod";

/**
 * What a clinic tells Twiceheard about itself.
 *
 * Everything the agent says about the clinic comes from here, so the agent
 * never invents a doctor, an opening hour or a phone number. The schema is
 * strict: an admin screen that sends an unknown field is a bug, not a
 * feature request.
 */

/** English voices on the Voice Agent API. The platform has no Hindi voice yet. */
export const VOICES = [
  "anna",
  "charles",
  "paul",
  "vera",
  "alba",
  "eve",
  "george",
  "jane",
  "jean",
  "mary",
  "michael",
] as const;

const slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "lowercase letters, digits and hyphens");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour");
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const doctorSchema = z.strictObject({
  id: slug,
  name: shortText(60),
  specialty: shortText(60),
});

export const clinicSchema = z
  .strictObject({
    id: slug,
    name: shortText(80),
    country: z.enum(["IN", "US"]),
    timezone: shortText(60),
    voice: z.enum(VOICES),
    doctors: z.array(doctorSchema).min(1).max(20),
    hours: z.strictObject({
      /** 0 is Sunday. */
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      open: time,
      close: time,
      slotMinutes: z.union([z.literal(15), z.literal(20), z.literal(30)]),
    }),
    /** Medication names the clinic hears often; they bias transcription. */
    formulary: z.array(shortText(50)).max(80),
  })
  .refine((clinic) => clinic.hours.open < clinic.hours.close, {
    message: "opening time must be before closing time",
    path: ["hours"],
  })
  .refine((clinic) => isTimeZone(clinic.timezone), {
    message: "not a known IANA time zone",
    path: ["timezone"],
  });

export type Clinic = z.infer<typeof clinicSchema>;
export type Doctor = z.infer<typeof doctorSchema>;

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The clinic every demo and test runs against. Fictional, like everyone in it. */
export const DEMO_CLINIC: Clinic = clinicSchema.parse({
  id: "sunrise-family",
  name: "Sunrise Family Clinic",
  country: "IN",
  timezone: "Asia/Kolkata",
  voice: "anna",
  doctors: [
    { id: "dr-kapoor", name: "Dr. Neha Kapoor", specialty: "General medicine" },
    { id: "dr-iyer", name: "Dr. Rahul Iyer", specialty: "Paediatrics" },
    { id: "dr-sen", name: "Dr. Farah Sen", specialty: "Dermatology" },
  ],
  hours: { days: [1, 2, 3, 4, 5, 6], open: "09:00", close: "18:00", slotMinutes: 20 },
  formulary: [
    "metformin",
    "atorvastatin",
    "amlodipine",
    "telmisartan",
    "levothyroxine",
    "pantoprazole",
    "paracetamol",
    "azithromycin",
    "cetirizine",
    "salbutamol",
  ],
});
