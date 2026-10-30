<div align="center">

# 摩羯 <sub>· dsh-capri</sub>

**DeepSeek Harness 的桌面挂件 + 桥插件 · macOS · 全中文**

<img src="docs/media/badge-macos.svg" alt="macOS arm64">
<img src="docs/media/badge-dsh.svg" alt="DSH">
<img src="docs/media/badge-zh.svg" alt="中文">
<img src="docs/media/badge-license.svg" alt="非商业">

<br><br>

<a href="https://github.com/Sophia-Pro/dsh-capri/releases/download/v0.2.0/MoJie-0.2.0-macOS-arm64.zip"><b>⬇ 挂件 v0.2.0（macOS arm64）</b></a>
&nbsp;·&nbsp;
<a href="https://github.com/Sophia-Pro/dsh-capri/releases/download/v0.2.0/MoJie-DSH-Plugin-0.2.0.zip"><b>⬇ DSH 插件 v0.2.0</b></a>

<br>

<a href="使用说明.md">使用说明</a>
&nbsp;·&nbsp;
<a href="玩法.md">玩法与动画</a>
&nbsp;·&nbsp;
<a href="NOTICE.md">来源与致谢</a>

</div>

<p align="center">
  <img src="docs/media/hero-2.jpg" alt="开场：她抓住你的屏幕边缘说嗨" width="820">
</p>

---

## 她做什么


## 会动的

**开场** —— 三种随机：抓屏幕的大近景 / 大头照「嗨」/ 小动作入场。

<p align="center"><img src="docs/media/intro-2.gif" alt="开场动画" width="720"></p>

**全屏附身** —— 整块屏幕变成她的脸，两秒后松开。

<p align="center"><img src="docs/media/screen-possess-2.gif" alt="全屏附身" width="720"></p>

**附身窗口** —— 坐久了钻进去，整扇窗长满她的眼睛和锯齿嘴：


**全屏附身** —— 整块屏幕变成她的脸，两秒后松开：


**看卫星** —— 她抬头、夜空铺开、卫星划过、红光照上去：


**开场动画**（三套随机）：大头照「嗨」/ 双手撑住屏幕边缘的大近景 / 小动作入场。


## 所有动画

37 个动作、三种开场、附身/全屏附身/看卫星这些大场面，以及每一个怎么触发，都写在全表里了：

<p align="center"><img src="docs/media/acts-2.jpg" alt="全部动作" width="760"></p>

**[→ 玩法与动画一览](玩法.md)**

## 和 DSH 的关系

`dsh-plugin/` 是桥插件：装进 DeepSeek Harness 后，DSH 里新的一轮、某个工具、等你批准、干完、烧了多少 token，都会变成她的话和动作（面板里那个「琢磨：…」就是她看见你在想什么）。

从 [Release](https://github.com/Sophia-Pro/dsh-capri/releases/tag/v0.1.0) 下 `MoJie-DSH-Plugin-0.1.0.zip` 解压，或者直接用仓库里的 `dsh-plugin/`：

```bash
cd dsh-plugin && npm install
dsh plugin --profile desktop add link:"$PWD"
```

装完重启一次 DSH。她的挂件也可以独立运行，不装插件只是少这些联动。

## 快速开始（从源码跑）

```bash
git clone https://github.com/Sophia-Pro/dsh-capri.git
cd dsh-capri
npm install
npm start                    # 先看能不能出人

./scripts/capri-build.sh . ~/Applications/摩羯.app   # 打包成 .app
```

完整说明见 [使用说明.md](使用说明.md)，动画和玩法细表见 [玩法.md](玩法.md)：托盘菜单每一项、双击/单击、音效、跟随 DSH 启停、常见问题。

## 特性一览

- **窗口交互**：坐上沿 / 骑窗 / 掉下来 / 附身 / 全屏附身；视频和全屏应用不坐
- **自适应**：按屏幕分辨率和缩放自动算大小；显示器增删、分辨率变化会重新收进可视区
- **互动**：单击随机说话（余额 / token / 进度 / 闲话），双击从所有动画里随机演一段（没演过的优先）
- **演技**：37 个动作（含从上游移植的蹲、瞪、被抱起、躺平、翻滚、过热…）、三种开场、全部音效为 Web Audio 实时合成
- **不抢焦点**：不占 Dock、不进 Cmd-Tab，点她不会把整个程序提到前台
- **中文化**：界面、台词、托盘、气泡全中文

## 版权

二次开发项目，原作 [mochiiwuff/capri-desktop](https://github.com/mochiiwuff/capri-desktop)，基于 [Stefanospi/Carpi-Evolution](https://github.com/Stefanospi/Carpi-Evolution)。来源、改动清单与致谢见 [NOTICE.md](NOTICE.md)。

许可证沿用上游：可自由使用、修改、分发，**不得售卖或用于付费服务**。角色与美术素材版权属于原权利人，本项目为同人作品。
