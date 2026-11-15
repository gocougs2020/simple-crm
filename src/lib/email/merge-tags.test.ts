import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customValueText, fillMergeTags, fillMergeTagsHtml, mergeValues } from "./merge-tags";

const values = mergeValues(
  { firstName: "Ana", lastName: "Ruiz", email: "ana@x.test", title: "CEO", organizationName: "Globex", clientName: "Globex renewal", ownerName: "Pat Owner", custom: { region: "West", tiers: ["Gold", "Plus"], vip: true, empty: null } },
  { name: "Sam Lee" },
);

describe("merge tags", () => {
  it("fills person, client, owner and sender tags", () => {
    assert.equal(fillMergeTags("{{first_name}} {{full_name}} <{{email}}> {{job_title}} at {{company}}", values), "Ana Ana Ruiz <ana@x.test> CEO at Globex");
    assert.equal(fillMergeTags("{{client_name}} · {{owner_first_name}} · {{sender_first_name}}", values), "Globex renewal · Pat · Sam");
  });
  it("fills custom fields by key, as text", () => {
    assert.equal(fillMergeTags("{{custom.region}} / {{custom.tiers}} / {{custom.vip}}", values), "West / Gold, Plus / Yes");
  });
  it("uses the fallback, or the tag's default, when a value is missing", () => {
    const blank = mergeValues({});
    assert.equal(fillMergeTags("Hi {{first_name}}", blank), "Hi there");
    assert.equal(fillMergeTags("Hi {{first_name|friend}}", blank), "Hi friend");
    assert.equal(fillMergeTags("{{custom.empty|n/a}} {{custom.missing|none}}", values), "n/a none");
  });
  it("leaves unknown tags alone, so campaigns can fill {{unsubscribe_url}} later", () => {
    assert.equal(fillMergeTags("{{unsubscribe_url}} {{nope}}", values), "{{unsubscribe_url}} {{nope}}");
  });
  it("escapes values in HTML but not the author's fallback", () => {
    const html = fillMergeTagsHtml("<p>{{company}} {{first_name|<b>you</b>}}</p>", mergeValues({ organizationName: "A&B <Co>" }));
    assert.equal(html, "<p>A&amp;B &lt;Co&gt; <b>you</b></p>");
  });
  it("reads custom values the way an email should", () => {
    assert.equal(customValueText(false), "No");
    assert.equal(customValueText([]), null);
    assert.equal(customValueText(42), "42");
  });
});
