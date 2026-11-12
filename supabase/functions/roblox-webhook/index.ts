// supabase/functions/roblox-webhook/index.ts
// Receives Roblox Creator Hub webhooks and stores analytics alerts.
//
// Deployed with JWT verification OFF (Roblox can't send a Supabase token):
//   supabase/config.toml ->  [functions.roblox-webhook]
//                            verify_jwt = false
// That makes verifyRobloxSignature() the ONLY thing stopping strangers
// from posting fake alerts.

import { createClient } from "npm:@supabase/supabase-js@2";

// New-style keys come as a JSON dictionary; "default" is the key Supabase creates.
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, secretKeys["default"]);

// Set with: supabase secrets set ROBLOX_WEBHOOK_SECRET=...
// The SAME value goes in the webhook's "Secret" field in Creator Hub.
const WEBHOOK_SECRET = Deno.env.get("ROBLOX_WEBHOOK_SECRET")!;

const MAX_AGE_SECONDS = 300; // reject anything signed more than 5 minutes ago (or ahead)

const encoder = new TextEncoder();

// HMAC-SHA256(message, secret), Base64-encoded — the format Roblox uses.
async function hmacBase64(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// Compares every character, even after a mismatch, so response time
// doesn't reveal how much of a guessed signature was correct.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyRobloxSignature(
  header: string | null,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  // 1. No header -> not from Roblox (or the webhook has no secret set).
  if (!header) return false;

  // 2. Header looks like "t=1794501234,v1=Zm9v...=".
  //    Split on the FIRST "=" only: Base64 signatures can end in "=" padding.
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name === "t") t = value;
    if (name === "v1") v1 = value;
  }
  if (!t || !v1) return false;

  // 3. Replay protection. Roblox's timestamp is Unix SECONDS.
  const sentAt = Number(t);
  if (!Number.isFinite(sentAt)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - sentAt) > MAX_AGE_SECONDS) return false;

  // 4–6. Recompute the signature over "<timestamp>.<body>".
  //      Primary: the raw bytes we received.
  if (timingSafeEqual(await hmacBase64(`${t}.${rawBody}`, secret), v1)) {
    return true;
  }
  //      Fallback: Roblox's own sample signs JSON.stringify(parsedBody),
  //      so also accept the compact re-serialized form. Still needs the secret.
  try {
    const compact = JSON.stringify(JSON.parse(rawBody));
    if (compact !== rawBody) {
      return timingSafeEqual(await hmacBase64(`${t}.${compact}`, secret), v1);
    }
  } catch {
    // Body isn't valid JSON -> definitely reject.
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Read the body as RAW TEXT — the signature covers these exact characters.
  const rawBody = await req.text();

  const valid = await verifyRobloxSignature(
    req.headers.get("roblox-signature"),
    rawBody,
    WEBHOOK_SECRET,
  );
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = JSON.parse(rawBody);

  // Sent by the "Test Response" button in Creator Hub.
  if (event.EventType === "SampleNotification") {
    return new Response("ok");
  }

  if (event.EventType === "AnalyticsAlert") {
    // AlertMessage is a JSON *string* inside the JSON, so parse it again.
    const msg = JSON.parse(event.EventPayload.AlertMessage);

    const { error } = await supabase.from("alerts").upsert(
      {
        notification_id: event.NotificationId,
        universe_id: msg.universe_id,
        metric: msg.metric,
        // Roblox's summary ends in "has fired" or "has recovered".
        status: msg.summary.includes("recovered") ? "recovered" : "fired",
        summary: msg.summary,
        current_value: msg.current_value ?? null, // undocumented field, keep as text
        evaluated_at: msg.evaluation_time_utc,
        raw: event, // keep everything so we can re-parse later
      },
      // Same NotificationId twice -> skip it (idempotent).
      { onConflict: "notification_id", ignoreDuplicates: true },
    );

    if (error) {
      console.error("Insert failed:", error);
      return new Response("Database error", { status: 500 });
    }
  }

  return new Response("ok");
});