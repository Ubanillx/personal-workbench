import type React from "react";
import { useState } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import { Alert, Button, Flex, Tabs, type TabsProps } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { WebDavBrowseListing } from "../../shared/types/domain";
import { useCrudFeedback, useListParams } from "../components/crud-hooks";
import { PageHeader } from "../components/page-header";
import { AccountsTab } from "../components/settings/accounts-tab";
import { canOpenSettingsTab, DEFAULT_SETTINGS_TAB, FILTER_ALL, isSettingsTab, type SettingsTabKey } from "../components/settings/constants";
import { OrgMembersTab } from "../components/settings/org-members-tab";
import { OrgOverviewTab } from "../components/settings/org-overview-tab";
import type { MemberRow } from "../components/settings/types";
import { WebDavTab } from "../components/settings/webdav-tab";
import { readPayload } from "../lib/form.server";
import {
  ACCOUNT_SORTABLE,
  accountCounts,
  accountsPage,
  archiveOrganization,
  createOrganization,
  decideJoinRequest,
  DEFAULT_ACCOUNT_SORT,
  DEFAULT_MEMBER_SORT,
  DEFAULT_ORG_SORT,
  inviteMember,
  listJoinRequests,
  listMemberCandidates,
  listOrganizations,
  MEMBER_SORTABLE,
  membersPage,
  ORG_SORTABLE,
  organizationsPage,
  removeMember,
  restoreOrganization,
  setMemberActive,
  setMemberRole,
  updateOrganization,
  type AccountFilters,
  type OrgFailure,
  type OrgSuccess,
} from "../lib/organization.server";
import { emptyPage, pagingOf, sortOf, type Paged } from "../lib/paging";
import { sortableKeys } from "../lib/paging.server";
import { requireManagerOrRedirect } from "../lib/ui.server";
import { assertOrgManage } from "../lib/session.server";
import {
  clearWebDavSettings,
  reportUploadSettingsView,
  resetReportUploadSettings,
  resolveWebDavTestConfig,
  saveReportUploadSettings,
  saveWebDavSettings,
  UNCONFIGURED_REPORT_UPLOAD_VIEW,
  webDavSettingsView,
} from "../lib/webdav-settings.server";
import { browseWithConfig, pingWebDav, sharedConnectionConfig, webDavErrorMessage } from "../lib/webdav.server";

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

  // 「组织总览」「账号总览」只有 admin 能切；「组织与成员」「WebDAV」manager 也能开
  const requestedTab = url.searchParams.get("tab") ?? DEFAULT_SETTINGS_TAB;
  const tab: SettingsTabKey =
    isSettingsTab(requestedTab) && canOpenSettingsTab(requestedTab, isAdmin) ? requestedTab : DEFAULT_SETTINGS_TAB;

  /**
   * 三张表（成员 / 组织 / 账号）都是**服务端分页**，共用同一组 `?page/?size/?sort/?order`——
   * 同一时刻只有一个 Tab 在渲染，所以没必要给每张表各带一套参数。
   * 筛选条件（`?q=` 关键词、`?role=`、`?state=`、`?scope=`、`?status=`）同样都在服务端生效。
   */
  const paging = pagingOf(url.searchParams);
  const filters: AccountFilters = {
    keyword: url.searchParams.get("q") ?? undefined,
    role: url.searchParams.get("role") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
  };
  // 账号总览（仅 admin）：`?scope=` 决定看全部 / 仅未加入 / 某个组织
  const scope = url.searchParams.get("scope") ?? FILTER_ALL;

  const members = current
    ? membersPage(current.id, filters, paging, sortOf(url.searchParams, sortableKeys(MEMBER_SORTABLE), DEFAULT_MEMBER_SORT))
    : emptyPage<MemberRow>(paging, DEFAULT_MEMBER_SORT);
  const orgRows = organizationsPage(
    user,
    { status: url.searchParams.get("status") ?? undefined },
    paging,
    sortOf(url.searchParams, sortableKeys(ORG_SORTABLE), DEFAULT_ORG_SORT),
  );
  const accounts = isAdmin
    ? accountsPage({ ...filters, scope }, paging, sortOf(url.searchParams, sortableKeys(ACCOUNT_SORTABLE), DEFAULT_ACCOUNT_SORT))
    : emptyPage<MemberRow>(paging, DEFAULT_ACCOUNT_SORT);
  // 分页后不能再去数数组长度：两个计数由服务端算
  const counts = isAdmin ? accountCounts() : { total: 0, unassigned: 0 };

  const requests = current ? listJoinRequests(user, { orgId: current.id }) : [];
  // 「添加成员」的候选：无组织、启用中、且不是管理员（管理员不隶属组织）
  const candidates = current && current.status === "active" ? (listMemberCandidates() as unknown as MemberRow[]) : [];

  return {
    me: { id: user.id, name: user.name, username: user.username, role: user.role, orgId: user.orgId },
    isAdmin,
    tab,
    organizations,
    orgRows,
    current,
    members: members as unknown as Paged<MemberRow>,
    candidates,
    pending: requests.filter((item) => item.status === "pending"),
    history: requests.filter((item) => item.status !== "pending").slice(0, 20),
    accounts: accounts as unknown as Paged<MemberRow>,
    scope,
    accountTotal: counts.total,
    unassignedCount: counts.unassigned,
    // WebDAV 连接配置是**按账号**的，管理员与组织管理者各自维护自己那份
    webdav: webDavSettingsView(user.id),
    // 「周报上传」的作用域是**当前组织**（D-53）：组织管理者配本组织，管理员可换组织；
    // 没有可管理的组织（组织列表为空 / 本组织已解散）时给未配置视图
    reportUpload: current ? reportUploadSettingsView(current) : UNCONFIGURED_REPORT_UPLOAD_VIEW,
    // 管理员在「周报上传」卡里切换组织用；组织管理者固定为本组织，所以候选为空
    reportOrgOptions: isAdmin
      ? organizations.filter((org) => org.status === "active").map((org) => ({ value: org.id, label: org.name }))
      : [],
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
    // 「周报上传」是**按组织**的目录配置（D-53）：连接共用管理员那份（D-52），
    // 组织管理者只能改本组织，管理员可改任意组织（`assertOrgManage` 就是这条规则）。
    // 管理员的 orgId 来自表单（卡片里的组织选择器）；组织管理者由上面的统一口径固定成自己的组织。
    case "save-report-upload": {
      if (!orgId) return { error: "请先选择要配置的组织" };
      if (assertOrgManage(user, orgId)) return { error: "只能配置本组织的周报上传目录" };
      const saved = saveReportUploadSettings(user.id, orgId, { root: payload.root });
      return saved.ok ? { ok: true, notice: "周报上传目录已保存" } : { error: saved.message };
    }
    case "reset-report-upload": {
      if (!orgId) return { error: "请先选择要配置的组织" };
      if (assertOrgManage(user, orgId)) return { error: "只能配置本组织的周报上传目录" };
      resetReportUploadSettings(orgId);
      return { ok: true, notice: "已恢复默认：本组织的周报写到连接的浏览根目录下" };
    }
    case "test-report-upload": {
      const config = sharedConnectionConfig();
      if (!config) return { error: "还没有可用的 WebDAV 连接：请先在上面「WebDAV 连接」里保存一次" };
      try {
        await pingWebDav(config);
        const target = `${config.url}${config.root === "/" ? "" : config.root}`;
        return { ok: true, notice: `连接成功：${target}` };
      } catch (error) {
        return { error: webDavErrorMessage(error) };
      }
    }
    // 与 `browse-webdav` 同一件事，只是用**共用连接**（管理员那份）去列目录：与组织无关
    case "browse-report-upload": {
      const config = sharedConnectionConfig();
      if (!config) return { error: "还没有可用的 WebDAV 连接：请先在上面「WebDAV 连接」里保存一次" };
      try {
        return { ok: true, browse: await browseWithConfig(config, String(payload.path ?? "")) };
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
  // 写操作成功时递增，通知各 Tab 收起自己打开的弹窗（Tab 组件的状态留在组件内部）
  const [successTick, setSuccessTick] = useState(0);

  const { error } = useCrudFeedback(actionData, () => setSuccessTick((tick) => tick + 1));
  const busy = navigation.state !== "idle";

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  /**
   * 参数写入统一走 `useListParams().patch`：与其它列表页同一套规则，
   * 而且**动了筛选/切换 Tab 会自动回到第 1 页**（否则 `?page=3` 会在新列表上越界）。
   */
  const { patch: patchParams } = useListParams();

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
          reportOrgOptions={data.reportOrgOptions}
          onSelectOrg={(orgId) => patchParams({ org: orgId })}
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
            organizations={data.orgRows}
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
        description={data.isAdmin ? "管理组织、成员与账号。" : "管理本组织成员。"}
        help="账号加入组织后才能访问业务页面。"
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
