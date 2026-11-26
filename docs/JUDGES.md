# Cold Read: a 10-minute walkthrough for judges

## What your site needs

A Confluence Cloud site with Rovo turned on and Jira on the same site (a demo site from `forge site provision` has both). No keys and no settings: the one-click run is paid by the app.

## Install

1. Open the install link, pick your site and install Cold Read in Confluence and in Jira on that site (the sample and the Jira issue need both); accept the permissions: https://developer.atlassian.com/console/install/e881a251-e585-4efe-8680-72dc90fcb38f?signature=AYABeJ8TmvayBXtf6zvl9smIcjIAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBqMH62LJyWhdgtZcwtjEqdgAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDE2P%2FWUnIhG8kNUBRgIBEIA7C6aIwSyLgnCJnJH5rPul%2BDMbYc%2Bgi%2Fwpt0yBG2h4JcRUgigjFWoJaM39%2FKIkpOZLCyoFZRzRZx42rFMAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgEdOenNFtThv%2BzL0v%2B1zOLRAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMrpyyY51od5FKB%2FxnAgEQgDsNk3neAUi%2B%2BtDQKl%2BA7mc0s%2FrEzZf%2B%2FXmNry1PKcyC%2BneCPpw1q5wOBGoSXwiU6RtO5Gc2UTvqH5%2FdDQAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAa3CXc1lScz9X0JbNDAxfQEAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAx4YcB6PeQOEalRKPwCARCAO3lmZ3GPQJnKTQB2WMKS0PkgajeTOI7nEQDKverM1XZuHWjSymzYJyb9trQp1oUk11sy4KuDOO0lyAyGAgAAAAAMAAAQAAAAAAAAAAAAAAAAAItHvpSuYao5JHfjmltmezz%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADKOGdkneDaKdO91%2FbClukFmNHUp6NM30SYI7QZg64I9wWa63%2BkmSX22KspLMEl7A6GJ4Vsekjj7hWlkTOfvWXNy3Ok%3D&product=confluence&product=jira
2. If you also try Cold Read from an MCP client, turn on the app's MCP tools for your site first (the usual step for any Forge app with MCP tools).

If **Space apps → Cold Read** says "Cold Read is not connected to Jira on this site", open the install link again and install it in Jira.

## Try the sample (about 7 minutes)

1. Open any Confluence space, then **Space apps → Cold Read**. Pick a Jira project for the two sample issues and click **Load sample handoffs**. In about 8 seconds the space gets a page "Cold Read sample: Payments on-call" with four handoffs of a made-up payments team, and the project gets two issues with the label `cold-read-sample`.
2. Open **On-call handoff: Payments, week 47 (Mira to Jon)**. Click **Cold Read** under the page title, then **Run cold read**. It takes about 30 seconds: a fresh reader answers five questions from the page alone, then again with the two Jira issues the page links, then the two are compared.
3. What you should see (the same in 5 of 5 of our runs):
   - under the title: **Cold Read · 1 critical**;
   - in the panel: "5 of 5 answered from the page · 0 not on the page · findings: 1 A, 0 B, 0 C, 4 match", and "Compared with:" the two sample issues;
   - the A finding is on **What is the single next step, and who does it?** The page says "If billing queue lag goes over 15 min tonight, restart billing-worker". The comment in "Duplicate pending charges from Tuesday's billing run" says "don't restart billing-worker while a billing run is in progress". A new on-call engineer who follows the page would cause the same duplicate charges again.
4. Fix the line. Edit the page and replace the line "If billing queue lag goes over 15 min tonight, restart billing-worker (see the Restart billing-worker runbook)." with this one (KEY is the key of the issue "Duplicate pending charges from Tuesday's billing run"):

   > If billing queue lag goes over 15 min tonight, don't restart billing-worker while the billing run is in progress. Lag during the run drains on its own, so wait for the run to show COMPLETED (KEY). If there's no progress for 20 min, page Payments Core. Outside a run, restart billing-worker (see the Restart billing-worker runbook).

   Publish, click **Cold Read**, then **Run again**. You should see **Cold Read · clear** and "findings: 0 A, 0 B, 0 C, 5 match" (3 of 3 of our runs).
5. Open **On-call handoff: Payments Core, week 47**, the handoff of the Payments Core team. Under "Next" it says "If Platform on-call pages us about a stuck billing run tonight, ask them to restart billing-worker." Click **Cold Read** under the page title, then **Run cold read** (about 20 seconds). What you should see (the same in 5 of 5 of our runs):
   - in the panel: "5 of 5 answered from the page · 0 not on the page", one A finding and no B or C, and "Compared with:" the two sample issues;
   - the A finding is on **What is the single next step, and who does it?** The page says "ask them to restart billing-worker". The comment in "Duplicate pending charges from Tuesday's billing run" says "don't restart billing-worker while a billing run is in progress". In 3 of our 5 runs the same finding also covers **What has already been done that must not be done again?**

   Then pick a Jira project at the bottom of the panel and click **Create Jira issue for the page owner**. The panel shows "Issue for the page owner:" and the key of the new issue, which lists the finding with a link to the page. On **Space apps → Cold Read**, the handoff shows that key under "Fix in Jira".
6. Back on **Space apps → Cold Read**, the table lists the pages of the space that have a cold read, worst first, with the sample handoffs that are not checked yet.

## Try your own page (about 3 minutes)

Create a page with these four lines:

```
I'm away from tomorrow. Sam takes over the release of the billing export.
Where it is: the release branch is cut and tested.
Next: Sam ships it on Monday.
Waiting on: nobody.
```

Add a link to any Jira issue of yours (type its key on the page), publish, and click **Cold Read**, then **Run cold read**. The panel answers the questions from the page alone, then compares the page with that issue and shows where they disagree, if they do.

## If the one-click runs run out

The site has an allowance of one-click runs that refills over time. When it is used up, the panel says "This site has used its one-click budget for now" and how soon runs come back. **Run in Rovo chat** in the same panel runs the same check with the Cold Reader in Rovo chat: confirm the actions it asks for, then click **Cold Read** under the page title again.

## Remove the sample

**Space apps → Cold Read → Remove sample** deletes the two issues (if you may not delete issues, it adds a comment and moves them to a done status where the workflow has one). Then delete the page "Cold Read sample: Payments on-call" with its children.
