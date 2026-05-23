// Supabase Edge Function: 创建支付宝订单（骨架）

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

// 套餐定价（单位：分）
const PLAN_PRICING: Record<string, number> = {
  day: 500,    // 5 元
  month: 3000, // 30 元
};

function generateOrderNo(): string {
  const timestamp = Date.now().toString();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `ORD${timestamp}${random}`;
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
    const { user_id, plan } = body;

    if (!user_id || typeof user_id !== "string") {
      return new Response(
        JSON.stringify({ error: "缺少 user_id 参数" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!plan || !["day", "month"].includes(plan)) {
      return new Response(
        JSON.stringify({ error: "plan 参数必须是 'day' 或 'month'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const amount = PLAN_PRICING[plan];
    const orderNo = generateOrderNo();

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .insert({
        user_id: user_id,
        order_no: orderNo,
        plan: plan,
        amount: amount,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw error;

    // TODO: 接入支付宝 SDK 创建支付订单，获取 pay_url
    const payUrl = "TODO";

    return new Response(
      JSON.stringify({
        order_id: order.id,
        order_no: order.order_no,
        amount: order.amount,
        plan: order.plan,
        pay_url: payUrl,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("create-alipay-order error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal Server Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
