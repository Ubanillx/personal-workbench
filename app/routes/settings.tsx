import type React from "react";
import { useState } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSearchParams, useSubmit } from "react-router";
import { Alert, Button, Flex, Tabs, type TabsProps } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { WebDavBrowseListing } from "../../shared/types/domain";
import { useCrudFeedback } from "../components/crud-hooks";
import { PageHeader } from "../components/page-header";
import { AccountsTab } from "../components/settings/accounts-tab";
import {
  canOpenSettingsTab,
  DEFAULT_SETTINGS_TAB,
  FILTER_ALL,
  FILTER_NONE,
  isSettingsTab,
  type SettingsTabKey,
} from "../components/settings/constants";
import { OrgMembersTab } from "../components/settings/org-members-tab";
import { OrgOverviewTab } from "../components/settings/org-overview-tab";
import type { MemberRow } from "../components/settings/types";
import { WebDavTab } from "../components/settings/webdav-tab";
import { readPayload } from "../lib/form.server";
import {
  archiveOrganization,
  createOrganization,
  decideJoinRequest,
  inviteMember,
  listAllAccounts,
  listJoinRequests,
  listMembers,
  listOrganizations,
  removeMember,
  restoreOrganization,
  setMemberActive,
  setMemberRole,
  updateOrganization,
  type OrgFailure,
  type OrgSuccess,
} from "../lib/organization.server";
import { requireManagerOrRedirect } from "../lib/ui.server";
import {
  clearReportUploadSettings,
  clearWebDavSettings,
  reportUploadSettingsView,
  resolveReportUploadTestConfig,
  resolveWebDavTestConfig,
  saveReportUploadSettings,
  saveWebDavSettings,
  UNCONFIGURED_REPORT_UPLOAD_VIEW,
  webDavSettingsView,
} from "../lib/webdav-settings.server";
import { browseWithConfig, pingWebDav, webDavErrorMessage } from "../lib/webdav.server";

/**
 * 设置页（docs/harness/ACCOUNTS_AND_ORGS.md §8）。
 *
 * 把原来三个"管理"页面合并成一个入口，减少操作冗余：
 * - `/organization`「组织管理」→ Tab「组织与成员」
 * - `/admin`「全局管理」      → Tab「组织总览」+ Tab「账号总览」
 * - `/collaboration`「协作管理」→ 整页退役（它的只读副本与上面两个 Tab 重复；访问地址只在 `/api/access-info`）
 *
 * 门禁与组织/成员/账号的全部业务规则仍来自 `app/lib/organization.server.ts`；
 * 本文件只做「统一门禁 + 合并 loader/action + Tab 编排」，界面在 `app/components/settings/`。
 *
 * 关键约束：合并后 action 的统一门禁是 `requireManagerOrRedirect`（manager 也要能用），
 * 所以 `create`（建组织）与 `restore`（恢复组织）必须在这里额外校验管理员身份。
 */

/**
 * 设置页 action 的返回信封。
 * `browse` 那一支只给「目录选择器」用：它走 `useFetcher`（不进页面导航），
 * 所以既不会触发页面顶部的成功提示，也不会被 `useCrudFeedback` 当成写操作。
 */
type ActionResult = { ok: true; notice: string } | { ok: true; browse: WebDavBrowseListing } | { error: string };

/** OrgFailure 的响应体里已经带好了 code/message，这里只把文案取出来给页面显示 */
async function toActionResult(result: OrgSuccess<unknown> | OrgFailure, notice: string): Promise<ActionResult> {
  if (result.ok) return { ok: true, notice };
  const payload = (await result.response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { error: payload?.error?.message ?? "操作失败，请稍后重试" };
}

export async function loader({ request }: { request: Request }) {
  const user = requireManagerOrRedirect(request);
  const url = new URL(request.url);
  const isAdmin = user.role === "admin";
  const organizations = listOrganizations(user);

  // `?org=` 是「当前管理的组织」：admin 可切换；manager 固定为自己的组织（不信任 URL）
  const requestedOrg = url.searchParams.get("org");
  const current = isAdmin
    ? (organizations.find((org) => org.id === requestedOrg) ??
      organizations.find((org) => org.status === "active") ??
      organizations[0] ??
      null)
    : (organizations.find((org) => org.id === user.orgId) ?? null);

  const allAccounts = listAllAccounts() as unknown as MemberRow[];
  const members = current ? (listMembers(current.id) as unknown as MemberRow[]) : [];
  const requests = current ? listJoinRequests(user, { orgId: current.id }) : [];
  // 「添加成员」的候选：无组织、启用中、且不是管理员（管理员不隶属组织）
  const candidates =
    current && current.status === "active"
      ? allAccounts.filter((account) => account.orgId === null && account.role !== "admin" && account.isActive === 1)
      : [];

  // 「组织总览」「账号总览」只有 admin 能切；「组织与成员」「WebDAV」manager 也能开
  const requestedTab = url.searchParams.get("tab") ?? DEFAULT_SETTINGS_TAB;
  const tab: SettingsTabKey =
    isSettingsTab(requestedTab) && canOpenSettingsTab(requestedTab, isAdmin) ? requestedTab : DEFAULT_SETTINGS_TAB;

  // 账号总览（仅 admin）：`?scope=` 决定看全部 / 仅未加入 / 某个组织
  const scope = url.searchParams.get("scope") ?? FILTER_ALL;
  const accounts = !isAdmin
    ? []
    : scope === FILTER_ALL
      ? allAccounts
      : scope === FILTER_NONE
        ? allAccounts.filter((account) => account.orgId === null)
        : allAccounts.filter((account) => account.orgId === scope);

  return {
    me: { id: user.id, name: user.name, username: user.username, role: user.role, orgId: user.orgId },
    isAdmin,
    tab,
    organizations,
    current,
    members,
    candidates,
    pending: requests.filter((item) => item.status === "pending"),
    history: requests.filter((item) => item.status !== "pending").slice(0, 20),
    accounts,
    scope,
    accountTotal: allAccounts.length,
    unassignedCount: allAccounts.filter((account) => account.orgId === null && account.role !== "admin").length,
    // WebDAV 连接配置是**按账号**的，管理员与组织管理者各自维护自己那份
    webdav: webDavSettingsView(user.id),
    // 「周报上传」是**全局单行**配置（D-46）：只有管理员能看能改，其余角色拿到的是未配置视图
    reportUpload: isAdmin ? reportUploadSettingsView() : UNCONFIGURED_REPORT_UPLOAD_VIEW,
  };
}

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireManagerOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  const isAdmin = user.role === "admin";
  // 目标组织：admin 从表单取；manager 一律用会话里的组织，不信任表单传的 orgId
  const orgId = isAdmin ? String(payload.orgId ?? "") : (user.orgId ?? "");
  const memberId = String(payload.memberId ?? "");
  const text = (key: string): string => (typeof payload[key] === "string" ? String(payload[key]) : "");
  const active = payload.active === true || payload.active === "true";
  const approve = payload.approve === true || payload.approve === "true";

  switch (intent) {
    case "create":
      // 统一门禁只到 manager，建组织必须再确认是管理员
      if (!isAdmin) return { error: "只有管理员可以创建组织" };
      return toActionResult(createOrganization(user, { name: payload.name, description: text("description") }), "组织已创建");
    case "restore":
      if (!isAdmin) return { error: "只有管理员可以恢复组织" };
      return toActionResult(restoreOrganization(user, orgId), "组织已恢复：成员需要重新申请或由管理者拉入");
    case "rename":
      return toActionResult(updateOrganization(user, orgId, { name: payload.name, description: text("description") }), "组织信息已保存");
    case "archive":
      return toActionResult(archiveOrganization(user, orgId), "组织已解散：成员已退回「未加入」状态，数据保留");
    case "toggle-member":
      return toActionResult(setMemberActive(user, memberId, active), active ? "成员已启用" : "成员已停用，其会话已失效");
    case "promote":
      return toActionResult(setMemberRole(user, memberId, "manager"), "已设为组织管理者");
    case "demote":
      return toActionResult(setMemberRole(user, memberId, "member"), "已降为普通用户");
    case "remove-member":
      return toActionResult(removeMember(user, memberId), "已移出组织：该账号回到「未加入」状态");
    case "invite":
      return toActionResult(inviteMember(user, orgId, String(payload.accountId ?? "")), "已把该账号拉入组织");
    case "decide":
      return toActionResult(
        decideJoinRequest(user, String(payload.requestId ?? ""), approve, text("note")),
        approve ? "申请已通过" : "申请已拒绝",
      );
    // WebDAV 配置：地址来自环境变量 WEBDAV_URL，这里只按当前账号保存凭据 / 清除 / 用表单值试连
    // （详见 app/components/settings/webdav-tab.tsx）
    case "save-webdav": {
      const saved = saveWebDavSettings(user.id, {
        username: payload.username,
        password: payload.password,
        root: payload.root,
        timeoutMs: payload.timeoutMs,
      });
      return saved.ok ? { ok: true, notice: "WebDAV 配置已保存" } : { error: saved.message };
    }
    case "clear-webdav":
      clearWebDavSettings(user.id);
      return { ok: true, notice: "WebDAV 配置已清除" };
    case "test-webdav": {
      const prepared = resolveWebDavTestConfig(user.id, {
        username: payload.username,
        password: payload.password,
        root: payload.root,
        timeoutMs: payload.timeoutMs,
      });
      if (!prepared.ok) return { error: prepared.message };
      try {
        await pingWebDav(prepared.config);
        const target = `${prepared.config.url}${prepared.config.root === "/" ? "" : prepared.config.root}`;
        return { ok: true, notice: `连接成功：${target}` };
      } catch (error) {
        return { error: webDavErrorMessage(error) };
      }
    }
    // 「目录选择器」用**表单当前值**（凭据常常还没保存）列一级远端目录，
    // 让用户直接把「浏览根目录」点出来，而不用自己拼路径。走 useFetcher，不进页面导航。
    case "browse-webdav": {
      const prepared = resolveWebDavTestConfig(user.id, {
        username: payload.username,
        password: payload.password,
        root: payload.root,
        timeoutMs: payload.timeoutMs,
      });
      if (!prepared.ok) return { error: prepared.message };
      try {
        return { ok: true, browse: await browseWithConfig(prepared.config, String(payload.path ?? "")) };
      } catch (error) {
        return { error: webDavErrorMessage(error) };
      }
    }
    // 「周报上传」是**全局单行**配置（D-46）：四个动作都必须再确认一次管理员身份——
    // action 的统一门禁只到 manager，而这几个动作改的是所有人的周报落点。
    case "save-report-upload": {
      if (!isAdmin) return { error: "只有管理员可以修改周报上传配置" };
      const saved = saveReportUploadSettings(user.id, {
        username: payload.username,
        password: payload.password,
        root: payload.root,
        timeoutMs: payload.timeoutMs,
      });
      return saved.ok ? { ok: true, notice: "周报上传配置已保存" } : { error: saved.message };
    }
    case "clear-report-upload": {
      if (!isAdmin) return { error: "只有管理员可以修改周报上传配置" };
      clearReportUploadSettings();
      return { ok: true, notice: "周报上传配置已清除：成员暂时无法提交周报" };
    }
    case "test-report-upload": {
      if (!isAdmin) return { error: "只有管理员可以测试周报上传配置" };
      const prepared = resolveReportUploadTestConfig({
        username: payload.username,
        password: payload.password,
        root: payload.root,
        timeoutMs: payload.timeoutMs,
      });
      if (!prepared.ok) return { error: prepared.message };
      try {
        await pingWebDav(prepared.config);
        const target = `${prepared.config.url}${prepared.config.root === "/" ? "" : prepared.config.root}`;
        return { ok: true, notice: `连接成功：${target}` };
      } catch (error) {
        return { error: webDavErrorMessage(error) };
      }
    }
    // 与 `browse-webdav` 同一件事，只是用**统一上传账号**的表单值去连
    case "browse-report-upload": {
      if (!isAdmin) return { error: "只有管理员可以选择周报上传目录" };
      const prepared = resolveReportUploadTestConfig({
        username: payload.username,
        password: payload.password,
        root: payload.root,
        timeoutMs: payload.timeoutMs,
      });
      if (!prepared.ok) return { error: prepared.message };
      try {
        return { ok: true, browse: await browseWithConfig(prepared.config, String(payload.path ?? "")) };
      } catch (error) {
        return { error: webDavErrorMessage(error) };
      }
    }
    default:
      return { error: "未知操作" };
  }
}

export default function SettingsRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const [params, setParams] = useSearchParams();
  // 写操作成功时递增，通知各 Tab 收起自己打开的弹窗（Tab 组件的状态留在组件内部）
  const [successTick, setSuccessTick] = useState(0);

  const { error } = useCrudFeedback(actionData, () => setSuccessTick((tick) => tick + 1));
  const busy = navigation.state !== "idle";

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  const patchParams = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  /** 跳到「组织与成员」Tab；带 orgId 时同时切换当前管理的组织 */
  const openMembers = (orgId?: string): void => {
    patchParams(orgId ? { tab: "members", org: orgId } : { tab: "members" });
  };

  const items: TabsProps["items"] = [
    {
      key: "members",
      label: "组织与成员",
      children: (
        <OrgMembersTab
          me={data.me}
          isAdmin={data.isAdmin}
          organizations={data.organizations}
          current={data.current}
          members={data.members}
          candidates={data.candidates}
          pending={data.pending}
          history={data.history}
          post={post}
          busy={busy}
          error={error}
          successTick={successTick}
          onSelectOrg={(orgId) => patchParams({ org: orgId })}
        />
      ),
    },
    {
      key: "webdav",
      label: "WebDAV",
      children: (
        <WebDavTab
          settings={data.webdav}
          reportUpload={data.reportUpload}
          isAdmin={data.isAdmin}
          post={post}
          busy={busy}
          successTick={successTick}
        />
      ),
    },
  ];

  if (data.isAdmin) {
    items.push(
      {
        key: "orgs",
        label: "组织总览",
        children: (
          <OrgOverviewTab
            organizations={data.organizations}
            post={post}
            busy={busy}
            error={error}
            successTick={successTick}
            onOpenMembers={openMembers}
          />
        ),
      },
      {
        key: "accounts",
        label: "账号总览",
        children: (
          <AccountsTab
            me={data.me}
            accounts={data.accounts}
            accountTotal={data.accountTotal}
            unassignedCount={data.unassignedCount}
            scope={data.scope}
            organizations={data.organizations}
            onScopeChange={(scope) => patchParams({ scope })}
            busy={busy}
            onOpenMembers={() => openMembers()}
          />
        ),
      },
    );
  }

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="设置"
        eyebrow="SETTINGS"
        description={data.isAdmin ? "管理全部组织、成员与账号，审批加入与退出申请。" : "管理本组织成员，审批加入与退出申请。"}
        help="未加入组织的账号需先被拉入组织，才能访问业务页面。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void revalidator.revalidate()} loading={busy}>
            刷新
          </Button>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}

      <Tabs activeKey={data.tab} onChange={(key) => patchParams({ tab: key })} items={items} />
    </Flex>
  );
}
