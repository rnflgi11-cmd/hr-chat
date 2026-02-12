import { createClient } from "@supabase/supabase-js";

function must(v: string | undefined, name: string) {
  if (!v) throw new Error(`${name} is required.`);
  return v;
}

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

export const supabaseAdmin = createClient(
  must(supabaseUrl, "supabaseUrl"),
  must(serviceRoleKey, "supabaseServiceRoleKey"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);
