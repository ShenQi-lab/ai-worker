-- 初始化数据库：AI 虚拟员工 H5 后端
-- 创建扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. user_quotas：用户配额表
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_quotas (
    user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    remaining       INT NOT NULL DEFAULT 3,
    membership      VARCHAR(20) NOT NULL DEFAULT 'free',
    expires_at      TIMESTAMPTZ,
    daily_used      INT NOT NULL DEFAULT 0,
    daily_reset_date DATE NOT NULL DEFAULT CURRENT_DATE,
    last_request_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.user_quotas IS '用户配额与会员信息';
COMMENT ON COLUMN public.user_quotas.remaining IS '剩余免费次数';
COMMENT ON COLUMN public.user_quotas.membership IS '会员类型：free/day/month';
COMMENT ON COLUMN public.user_quotas.expires_at IS '会员过期时间';
COMMENT ON COLUMN public.user_quotas.daily_used IS '今日已使用次数';
COMMENT ON COLUMN public.user_quotas.daily_reset_date IS '每日重置日期';

-- ============================================================
-- 2. orders：订单表
-- ============================================================
CREATE TABLE IF NOT EXISTS public.orders (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    order_no    VARCHAR(32) NOT NULL UNIQUE,
    plan        VARCHAR(20) NOT NULL,
    amount      INT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    pay_channel VARCHAR(20),
    paid_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.orders IS '会员购买订单';
COMMENT ON COLUMN public.orders.status IS '订单状态：pending/paid/cancelled/refunded';
COMMENT ON COLUMN public.orders.plan IS '套餐类型：day/month';

-- ============================================================
-- 3. chat_logs：聊天日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_logs (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_message TEXT NOT NULL,
    bot_reply   TEXT NOT NULL,
    tokens_used INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.chat_logs IS '用户与 Bot 的聊天记录';

-- ============================================================
-- 4. rate_limit_logs：速率限制日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS public.rate_limit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ip_address      INET,
    request_count   INT NOT NULL DEFAULT 1,
    window_start    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.rate_limit_logs IS 'IP/用户请求频率限制日志';

-- ============================================================
-- 索引
-- ============================================================

-- user_quotas 索引
CREATE INDEX IF NOT EXISTS idx_user_quotas_membership ON public.user_quotas(membership);
CREATE INDEX IF NOT EXISTS idx_user_quotas_expires_at ON public.user_quotas(expires_at);

-- orders 索引
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);

-- chat_logs 索引
CREATE INDEX IF NOT EXISTS idx_chat_logs_user_id ON public.chat_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_logs_created_at ON public.chat_logs(created_at DESC);

-- rate_limit_logs 索引
CREATE INDEX IF NOT EXISTS idx_rate_limit_logs_user_id ON public.rate_limit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_logs_ip ON public.rate_limit_logs(ip_address);
CREATE INDEX IF NOT EXISTS idx_rate_limit_logs_window ON public.rate_limit_logs(window_start);

-- ============================================================
-- 更新触发器（自动更新 updated_at）
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_user_quotas_updated_at
    BEFORE UPDATE ON public.user_quotas
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER tr_orders_updated_at
    BEFORE UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 启用 Row Level Security
-- ============================================================
ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS 策略：用户只能 SELECT 自己的数据
-- ============================================================

-- user_quotas：用户只能看自己的配额
CREATE POLICY "用户只能查看自己的配额"
    ON public.user_quotas
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- orders：用户只能看自己的订单
CREATE POLICY "用户只能查看自己的订单"
    ON public.orders
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- chat_logs：用户只能看自己的聊天记录
CREATE POLICY "用户只能查看自己的聊天记录"
    ON public.chat_logs
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- rate_limit_logs：用户只能看自己的限流日志
CREATE POLICY "用户只能查看自己的限流日志"
    ON public.rate_limit_logs
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- ============================================================
-- 新用户注册时自动创建配额记录
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_quotas (user_id, remaining, membership, daily_used, daily_reset_date)
    VALUES (NEW.id, 3, 'free', 0, CURRENT_DATE)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 监听 auth.users 新增事件
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
