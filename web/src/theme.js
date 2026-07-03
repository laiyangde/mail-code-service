/**
 * antd 全局主题（深空蓝青 Deep Space Cyan）。
 *
 * 只定义「设计语言」，不含任何业务；取码页与 Admin 后台共用，保证全站气质一致。
 * 与 styles/tokens.css 的 CSS 变量同源（此处给 antd 组件用，CSS 变量给自绘元素用），
 * 改色时两处一起改。基调：slate 深空底 + cyan 主色 + green 收码成功高光。
 */
import { theme } from 'antd';

/** 深空蓝青主题配置对象，传入 ConfigProvider 的 `theme` */
export const appTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    // 品牌主色：亮青（sky-400），冷静科技、延续原有蓝调
    colorPrimary: '#38bdf8',
    colorInfo: '#38bdf8',
    // 收码成功高光：绿
    colorSuccess: '#22c55e',
    colorWarning: '#fbbf24',
    colorError: '#f43f5e',
    // 深空背景层级（darkAlgorithm 以 colorBgBase 为锚点派生其余灰阶）
    colorBgBase: '#0b1120',
    colorBgContainer: '#111a2e',
    colorBgElevated: '#1b2942',
    colorBgLayout: 'transparent', // 让 body 的氛围渐变背景透出
    // 文字与边框
    colorTextBase: '#e6edf7',
    colorBorder: '#243149',
    colorBorderSecondary: '#1b2740',
    // 形状 / 字体 / 控件尺寸（整体更舒展）
    borderRadius: 12,
    borderRadiusLG: 16,
    borderRadiusSM: 8,
    fontFamily:
      "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    fontSize: 14,
    controlHeight: 38,
    controlHeightLG: 46,
    controlHeightSM: 28,
    lineHeight: 1.6,
    wireframe: false,
    boxShadow: '0 12px 32px -12px rgba(0,0,0,0.55)',
    boxShadowSecondary: '0 8px 24px -10px rgba(0,0,0,0.5)',
  },
  components: {
    // 卡片：半透明 + CSS backdrop-blur 形成玻璃质感（见 styles/*.css）
    Card: {
      colorBgContainer: 'rgba(17,26,46,0.72)',
      borderRadiusLG: 18,
      paddingLG: 26,
    },
    // 按钮：主按钮的渐变与辉光交给 CSS，这里只去掉默认硬阴影、加粗字重
    Button: {
      fontWeight: 600,
      primaryShadow: 'none',
      defaultShadow: 'none',
      controlHeight: 38,
      controlHeightLG: 46,
    },
    Layout: {
      headerBg: 'rgba(11,17,32,0.7)',
      headerHeight: 62,
      headerPadding: '0 24px',
      bodyBg: 'transparent',
    },
    Tabs: {
      inkBarColor: '#38bdf8',
      itemSelectedColor: '#e6edf7',
      itemHoverColor: '#38bdf8',
      titleFontSize: 15,
      horizontalItemGutter: 28,
    },
    Table: {
      headerBg: 'rgba(22,34,59,0.9)',
      headerColor: '#9fb0c9',
      borderColor: '#243149',
      rowHoverBg: 'rgba(56,189,248,0.06)',
      headerSplitColor: 'transparent',
      cellPaddingBlockSM: 10,
    },
    Statistic: {
      contentFontSize: 30,
      titleFontSize: 13,
    },
    Steps: {
      colorPrimary: '#38bdf8',
      titleLineHeight: 1.4,
    },
    Modal: {
      contentBg: '#141f36',
      headerBg: 'transparent',
      titleFontSize: 18,
    },
    Input: {
      colorBgContainer: 'rgba(9,14,26,0.55)',
      activeShadow: '0 0 0 2px rgba(56,189,248,0.18)',
    },
    InputNumber: { colorBgContainer: 'rgba(9,14,26,0.55)' },
    Select: { colorBgContainer: 'rgba(9,14,26,0.55)' },
    Result: { titleFontSize: 22 },
  },
};
