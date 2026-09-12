import type React from "react";
import logoUrl from "../assets/logo.png";

/** Logo 资源地址：品牌图与浏览器页签图标共用（见 root.tsx 的 <link rel="icon">）。 */
export const brandLogoUrl = logoUrl;

/**
 * 系统 Logo（横向字标 180×60，约 3:1）。
 * 只锁定高度、宽度按原图比例自适应，因此不能塞进固定宽高的 Avatar（会被裁成正方形），
 * 这里直接用 <img>，侧栏品牌区与登录 / 注册 / 改密 / 入组页共用。
 */
export function BrandLogo({ height = 28 }: { height?: number }): React.ReactElement {
  return <img className="brand-logo" src={brandLogoUrl} alt="个人工作台" height={height} />;
}
