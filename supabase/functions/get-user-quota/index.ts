// Supabase Edge Function: 查询用户配额 + 套餐列表

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

// ===================== 防刷辅助函数 =====================
function getClientIP(req: Request): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim();
  return null;
}

async function checkRateLimit(ip: string | null): Promise<boolean> {
  if (!ip) return true;
  const today = new Date().toISOString().split('T')[0] + 'T00:00:00Z';
  const { count, error } = await supabaseAdmin
    .from("rate_limit_logs")
    .select("*", { count: "exact", head: true })
    .eq("ip_address", ip)
    .gte("window_start", today);
  if (error) {
    console.error("rate limit check error:", error);
    return true;
  }
  return (count || 0) < 3;
}

async function recordRateLimit(ip: string | null, userId: string) {
  if (!ip) return;
  await supabaseAdmin.from("rate_limit_logs").insert({
    user_id: userId,
    ip_address: ip,
    window_start: new Date().toISOString(),
  });
}

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
    const { user_id, device_fp } = body;
    const clientIP = getClientIP(req);

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
      // 新用户，检查 IP 防刷
      const allowed = await checkRateLimit(clientIP);
      if (!allowed) {
        return new Response(
          JSON.stringify({ error: "今日注册次数已达上限" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

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

      // 记录本次注册到限流日志
      await recordRateLimit(clientIP, user_id);
    } else if (error) {
      throw error;
    }

    // 跨天重置检查
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

    // 查询定价套餐
    const { data: plans, error: plansError } = await supabaseAdmin
      .from("pricing_plans")
      .select("*")
      .order("price", { ascending: true });

    if (plansError) throw plansError;

    // 根据会员类型返回对应的 daily_limit
    let dailyLimit = 3; // 免费用户
    if (isMember) {
      const plan = plans?.find(p => p.plan === quota.membership);
      dailyLimit = plan?.daily_limit || 500;
    }

    return new Response(
      JSON.stringify({
        remaining: quota.remaining,
        membership: quota.membership,
        expires_at: quota.expires_at,
        is_member: isMember,
        daily_used: dailyUsed,
        daily_limit: dailyLimit,
        plans: plans || [],
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