# @linxin666/dsh-modef

模型选择 + 推理强度滑块：模型保持下拉菜单，推理强度改为 Claude 风格滑块。最高档带可选动画样式（「喷射流光」粒子 / 「暗流涌动」点阵涌动），并在 Harness 通用设置中提供「高级的推理强度选择」开关与动画样式选择器。

Model picker + reasoning-effort slider for the DeepSeek Harness web UI: keeps the model as a dropdown and replaces the effort control with a Claude-style slider. The max tier has selectable animation styles ("喷射流光" rocket spray / "暗流涌动" dot-matrix surge), toggled from General settings via "高级的推理强度选择" plus a style picker.

## 功能 Features

- 模型下拉菜单（官方模型目录，分组显示）
- 推理强度滑块（档位来自模型 reasoning 配置：Off / High / Max 等）
- 最高档动画样式（设置里切换）：
  - **喷射流光 (spray-flow)**：蓝紫渐变流光 + 火箭喷射粒子，粒子从喷口逐渐点火喷出
  - **暗流涌动 (undertow)**：白→紫渐变点阵 + 亮点从右端喷射向左涌动、逐渐消散；进出场动画
- 通用设置开关：「高级的推理强度选择」开启后接管输入框模型座位（priority -100 遮蔽官方选择器），关闭恢复官方设计
- 中英双语界面文案

## 安装 Install（作为 DSH profile bundle）

本包未发布到 npm，通过本地 `link:` 依赖挂载到 dsh profile（以 desktop 为例）：

```bash
cd ~/.dsh/profiles/desktop
pnpm add "link:F:/Harnes workspace/dsh-modef"
# 依赖声明为 link: 本地路径；dsh 会自动把它加入 dsh.profile.bundles
```

> **注意（必需）**：设置面板的开关依赖 `settings.describe` 白名单，需要把命名空间 `dsh-modef` 加入 `@deepseek-ai/dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES`（官方决策点，位于部署的 `node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js`）：

```js
const WEB_SETTINGS_NAMESPACES = [
  // ...
  "web-search-deepseek",
  "dsh-modef"
];
```

DSH 升级覆盖该文件后需重新添加一行。

## 结构 Structure

```
dsh-modef/
├── lib/
│   ├── index.js    # Host 半区：注册 dsh-modef 设置命名空间（advancedEffort / effortStyle）
│   └── client.js   # Client 半区：模型下拉 + 推理滑块 + 动画特效 + 设置行（开关/样式选择器）
├── cordis.patch.yml  # bundle patch：insert dsh-modef entry
└── package.json      # dsh.bundle + dsh.client 声明
```

## License

MIT
