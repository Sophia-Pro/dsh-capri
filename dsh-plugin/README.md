# dsh-plugin-capri-bridge

把 DSH（DeepSeek Harness）的会话事件喂给桌面宠物 **Capri**，让她像盯 Claude Code 一样盯 DSH：
播报工具动作、需要你批准时跑过来找你、干完庆祝并报本轮账、顺手报余额。

Capri 没开、服务缺失、事件形状变了，插件全都静默跳过，**不影响 DSH 本体**。

## 它把什么翻译成什么

| DSH 事件 | 发给 Capri 的事件 | 她会做什么 |
|---|---|---|
| `turn/start` | `SessionStart`（每个会话一次）+ `UserPromptSubmit` | 说"新单子"，跑到窗口上/角落 |
| `tool/call` | `PreToolUse` | 头顶滚动条显示"运行 npm test"这类动作，Bash/Web 时手指冒红火花 |
| `tool/result`（出错） | `PostToolUseFailure` | 红屏撞击 + 报错行 |
| `tool/call` 且工具是问用户 | 额外 `Notification` | 跑到鼠标旁/指窗口，等你点头 |
| `approval/asked` | `Notification` | 同上 |
| `turn/end` | `Stop`（带整段回答文本）+ `Note` | 胜利动作、摘要，外加"余额 / 本轮 token / 步数" |
| `subagent/start` / `subagent/end` | `SubagentStart` / `SubagentStop` | 报子智能体上线/回来 |
| `session/title` | 写进每条事件的 `session_title` | 面板上的标签 |

工具名会归一成 Capri 认识的名字（`read_file`→`Read`、`bash`→`Bash`、`edit_file`→`Edit`、
`web_fetch`→`WebFetch`、`grep`→`Grep`…），参数名也一并归一（`path`→`file_path`、`cmd`→`command`）。
认不出来的工具原样透传，她会说"使用 某工具"。

## 配置

`cordis.patch.yml` 里的 `config`：

```yaml
- insert:
    - id: capri-bridge
      name: dsh-plugin-capri-bridge
      config:
        port: 47823        # Capri 的本地桥端口，改了她的 config 这里也要改
        quota: true        # 干完报余额（走 ctx.get('deepseekAccount').getBalance）
        quotaEveryMs: 60000 # 最多一分钟报一次
        log: true          # 调试日志写到 /tmp/dsh-capri-bridge.log（可用 CAPRI_BRIDGE_LOG 改路径）
```

## 装 / 卸

装（本机已装好，命令留档）：

```bash
# 1) 把包放进 desktop profile（link 依赖，改代码即时生效）
#    ~/.dsh/profiles/desktop/package.json
#      dependencies: "dsh-plugin-capri-bridge": "link:."
#      dsh.profile.bundles: 加一项 "dsh-plugin-capri-bridge"
# 2) 建软链
ln -sfn . ~/.dsh/profiles/desktop/node_modules/dsh-plugin-capri-bridge
# 3) 重启 DSH（关掉 App 再开）——插件在启动时挂载
```

卸：

```bash
rm ~/.dsh/profiles/desktop/node_modules/dsh-plugin-capri-bridge
# 再从 package.json 的 dependencies 与 dsh.profile.bundles 里删掉那一项，重启 DSH
```

`package.json.bak-capri-*` 是装之前的备份。

## 已知限制

- 必须重启 DSH 才会加载；热装不行。
- DSH 的 `tool/result` 里"是否失败"的字段各版本不完全一致，插件做了多重探测（`isError` / 错误文本）；
  认不出来时只是不播报失败动画，不影响其它行为。
- 会话必须真的在跑（有 turn），她才动；光开着 DSH 她只是待着。
- 端口被占（另开了一个 Capri）时事件发不出去，日志里是 `post fail`。
