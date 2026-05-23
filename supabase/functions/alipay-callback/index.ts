// Supabase Edge Function: 支付宝回调（空壳）
// 支付宝服务器会以 POST 形式发送支付结果通知到此接口

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      "success",
      { status: 200, headers: { ...corsHeaders, "Content-Type": "text/plain" } }
    );
  }

  try {
    // TODO: 接入支付宝 SDK 验签
    // 1. 读取回调参数
    // 2. 验证支付宝签名
    // 3. 根据 out_trade_no 查询 orders 表
    // 4. 更新订单状态为 paid
    // 5. 更新 user_quotas：设置 membership 和 expires_at

    const body = await req.json();
    console.log("alipay callback received:", JSON.stringify(body));

    // 支付宝要求返回纯文本 "success"，否则会重复通知
    return new Response("success", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  } catch (err: any) {
    console.error("alipay-callback error:", err);
    // 即使出错也要返回 success，避免支付宝无限重试
    return new Response("success", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }
});
