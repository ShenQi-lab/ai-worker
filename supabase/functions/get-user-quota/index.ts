// Supabase Edge Function: 查询用户配额

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method Not Allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const { user_id } = body;

    if (!user_id || typeof user_id !== "string") {
      return new Response(
        JSON.stringify({ error: "缺少 user_id 参数" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 查询配额，不存在则自动创建
    let { data: quota, error } = await supabaseAdmin
      .from("user_quotas")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (error && error.code === "PGRST116") {
      const { data: newQuota, error: insertError } = await supabaseAdmin
        .from("user_quotas")
        .insert({
          user_id: user_id,
          remaining: 3,
          membership: "free",
          daily_used: 0,
          daily_reset_date: new Date().toISOString().split("T")[0],
        })
        .select()
        .single();

      if (insertError) throw insertError;
      quota = newQuota;
    } else if (error) {
      throw error;
    }

    // 跨天重置检查（返回前做实时计算，但不写入数据库）
    const today = new Date().toISOString().split("T")[0];
    let dailyUsed = quota.daily_used;
    if (quota.daily_reset_date !== today) {
      dailyUsed = 0;
    }

    // 判断是否有效会员
    const isMember =
      quota.membership !== "free" &&
      quota.expires_at &&
      new Date(quota.expires_at) > new Date();

    return new Response(
      JSON.stringify({
        remaining: quota.remaining,
        membership: quota.membership,
        expires_at: quota.expires_at,
        is_member: isMember,
        daily_used: dailyUsed,
        daily_limit: 500,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("get-user-quota error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal Server Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
