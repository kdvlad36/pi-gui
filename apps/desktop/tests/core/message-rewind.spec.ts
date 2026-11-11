import { writeFile, readFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  initGitRepo,
  commitAllInGitRepo,
  writeProjectExtension,
  waitForWorkspaceByPath,
  waitForTimelineLayout,
} from "../helpers/electron-app";

const extension = String.raw`
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
export default function(pi){pi.registerProvider("rewind-test",{baseUrl:"http://127.0.0.1:9/never-contact",apiKey:"LOCAL_TEST",api:"rewind-test",models:[{id:"scripted",name:"Rewind test",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context){
const index=context.messages.findLastIndex(m=>m.role==="user");
const edit=JSON.stringify(context.messages[index]).includes("edit files");
const finished=!edit||context.messages.slice(index+1).some(m=>m.role==="toolResult");
const message={role:"assistant",content:finished?[{type:"text",text:edit?"Файл изменён":"Без изменений"}]:[{type:"toolCall",id:"write",name:"write",arguments:{path:"a.txt",content:"agent\n"}}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:finished?"stop":"toolUse",timestamp:Date.now()};
const stream=createAssistantMessageEventStream();stream.push({type:"start",partial:{...message,content:[]}});if(finished)stream.push({type:"text_delta",contentIndex:0,delta:message.content[0].text,partial:message});stream.push({type:"done",reason:message.stopReason,message});return stream;
}})};`;

for (const choice of ["Откатить", "Оставить", "конфликт", "нет изменений"]) {
  test(`message rewind: ${choice}`, async () => {
    test.setTimeout(120_000);
    const userDataDir = await makeUserDataDir(),
      agentDir = join(userDataDir, "agent"),
      workspace = await makeWorkspace("message-rewind");
    await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "rewind-test",
        defaultModel: "scripted",
        enabledModels: ["rewind-test/scripted"],
        packages: [],
        cacheWarming: "off",
        compaction: { enabled: false },
      }),
    );
    await initGitRepo(workspace);
    await writeFile(join(workspace, "a.txt"), "original\n");
    await writeProjectExtension(workspace, "rewind-test.ts", extension);
    await commitAllInGitRepo(workspace, "Before rewind");
    let harness = await launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      testMode: "foreground",
    });
    try {
      const page = await harness.firstWindow();
      await waitForWorkspaceByPath(page, workspace);
      await page
        .locator(".sidebar")
        .getByRole("button", { name: "New thread", exact: true })
        .click();
      const prompt = choice === "нет изменений" ? "just talk" : "edit files";
      await page.getByLabel("New thread prompt", { exact: true }).fill(prompt);
      await page.getByRole("button", { name: "Start thread", exact: true }).click();
      await expect(page.locator(".timeline-item--assistant")).toContainText(
        choice === "нет изменений" ? "Без изменений" : "Файл изменён",
      );
      await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
      if (choice === "конфликт") await writeFile(join(workspace, "a.txt"), "human\n");
      await waitForTimelineLayout(page);
      await page.locator(".timeline-item--user").hover();
      const button = page.getByRole("button", { name: "Вернуть в поле ввода", exact: true });
      await expect(button).toBeEnabled();
      await page.screenshot({ path: join(userDataDir, "rewind-button.png") });
      await button.click();
      if (choice !== "нет изменений") {
        await expect(
          page.getByRole("heading", { name: "Откатить изменения в файлах?", exact: true }),
        ).toBeVisible();
        if (choice === "конфликт")
          await expect(page.getByRole("button", { name: "Откатить", exact: true })).toBeDisabled();
        await page.screenshot({ path: join(userDataDir, "rewind-dialog.png") });
        await page
          .getByRole("button", {
            name: choice === "Откатить" ? "Откатить" : "Оставить",
            exact: true,
          })
          .click();
      }
      await expect(page.getByTestId("composer")).toHaveValue(prompt);
      await expect(page.locator(".timeline-item--assistant")).toHaveCount(0);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        choice === "конфликт" ? "human\n" : choice === "Оставить" ? "agent\n" : "original\n",
      );
      await page.screenshot({ path: join(userDataDir, "rewind-complete.png") });
      if (choice === "Откатить") {
        const copies = await readdir(join(userDataDir, "message-rewind-backups", "files"));
        expect(copies.length).toBe(1);
        await expect(
          lstat(join(userDataDir, "message-rewind-backups", "files", copies[0]!, "manifest.json")),
        ).resolves.toBeTruthy();
      }
      // The original messages remain in Pi's tree rather than being deleted from disk.
      if (choice === "Откатить")
        await page.getByRole("button", { name: "Закрыть", exact: true }).click();
      await page.getByTestId("composer").fill("/tree");
      await page.getByTestId("composer").press("Enter");
      await expect(page.getByTestId("tree-modal")).toContainText(prompt);
      if (choice === "Откатить") {
        await page
          .getByTestId("tree-modal")
          .getByRole("button", { name: "Close tree modal" })
          .click();
        await page.getByTestId("composer").fill(prompt);
        await harness.close();
        harness = await launchDesktop(userDataDir, {
          agentDir,
          initialWorkspaces: [workspace],
          scrubProviderEnv: true,
          testMode: "foreground",
        });
        const reopened = await harness.firstWindow();
        await expect(reopened.getByTestId("composer")).toHaveValue(prompt);
        await expect(reopened.locator(".timeline-item--assistant")).toHaveCount(0);
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("original\n");
      }
      console.log("Rewind evidence:", userDataDir);
    } finally {
      await harness.close();
    }
  });
}
