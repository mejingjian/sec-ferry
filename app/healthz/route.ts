// 存活探针：只回答「进程还能响应 HTTP 吗」，不触碰任何外部依赖。
//
// 为什么要和就绪探针分开：容器编排里两者语义不同 ——
//   liveness 失败 → 重启容器；readiness 失败 → 摘掉流量。
// 若用同一个「查库」探针做 liveness，数据库短暂不可用会被误判成进程死了，
// 于是容器被反复重启，反而放大故障。旧实现只能拿首页 `/` 探活，区分不出这两种状态。
//
// 该路由不读数据库、不读配置，因此即使依赖全挂也应当返回 200。

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", uptimeSeconds: Math.round(process.uptime()), at: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
