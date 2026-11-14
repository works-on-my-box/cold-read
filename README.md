# Cold Read

Cold Read is an Atlassian Forge app for Confluence and Rovo. It checks what a newcomer, or an AI agent, will understand from a Confluence page before they act on it.

A fresh Rovo agent reads one page with no other context and answers the questions the next reader would ask, such as the five questions of a handoff. If the page owner gave expected answers, every difference becomes a finding: A if a reader would act differently or repeat something already done, B if the page is wrong or out of date, C if it leaves something out. Without expected answers, the agent compares its answers with related pages and Jira issues found by search. Findings of class A can go to the page owner as a Jira issue.

The same check is open to Claude Code and other MCP clients through a `rovo:mcp` module, with a skill that tells an agent to look at the Cold Read status of a runbook or handoff page before acting on it (`skills/checking-cold-read-before-acting/`).

Built for Codegeist 2026. Installation and usage instructions will be added before the submission.

## License

MIT, see [LICENSE](LICENSE).
