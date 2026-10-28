# 来源与致谢

这是一个**独立仓库**（不是 GitHub fork），代码基于下面两个项目继续开发；所有原作版权归原作者：

- **mochiiwuff / capri-desktop** — 原始项目，角色「Capri」、Sprite 着色器、桌面宠物行为、动画与美术都出自这里。
  https://github.com/mochiiwuff/capri-desktop
- **Stefanospi / Carpi-Evolution** — 本仓库直接基于的分支。
  https://github.com/Stefanospi/Carpi-Evolution
- 角色与剧集相关素材（`assets/capri/`、`docs/`）版权属于其权利人，仅作同人用途，不在代码许可证范围内。

## 本仓库改了什么

- 中文本地化：台词、面板、托盘菜单、气泡文案全部中文（只保留中文）。
- macOS 适配：窗口追踪（Swift 助手调用 `CGWindowListCopyWindowInfo`）、坐在窗口上沿/下沿、跟随窗口移动、附身窗口、全屏附身、按屏幕自动缩放、显示器/分辨率变化自适应。
- DeepSeek Harness 集成：`dsh-plugin/` 里的桥插件把 DSH 的会话事件（轮次、工具调用、等待批准、token）转成她认的事件；另有一条旁路直接读 DSH 的会话投影，不重启也能看见在干什么。
- 新增内容：三种开场（大头照「嗨」/ 抓屏幕 / 小动作入场）、全屏附身、双击随机表演、托盘「全部演一遍」「音效试听」、一批合成音效。
- 从上游 mochiiwuff 移植了 12 个动作（蹲、被榨干、瞪、被抓起、被托着、哼、躺平、扑、过热、抖、落地、翻滚）。

许可证沿用上游（见 `LICENSE`）：可自由使用、修改、再分发，**但不得用于售卖或付费服务**；需保留原作者署名。
