// Computes the ROI field for every item on the GitHub Project board.
//
//   ROI = (priority weight / effort weight) * 10, rounded to 1 decimal
//
// Higher priority and lower effort => higher ROI.
// Lower priority and higher effort => lower ROI.
//
// If Effort is not set but Estimate (hours) is, the estimate is used as the
// effort weight instead. Items missing both Priority and an effort signal are
// skipped and their ROI is left untouched.

const PRIORITY_WEIGHT = {
  "P0 - Critical": 4,
  "P1 - High": 3,
  "P2 - Medium": 2,
  "P3 - Low": 1,
};

const EFFORT_WEIGHT = {
  XS: 1,
  S: 2,
  M: 3,
  L: 5,
  XL: 8,
};

module.exports = async ({ github, core, owner, projectNumber }) => {
  const projectQuery = `
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
            }
          }
        }
      }
    }`;

  const projectData = await github.graphql(projectQuery, { owner, number: projectNumber });
  const project = projectData.user.projectV2;
  const fieldByName = Object.fromEntries(project.fields.nodes.map((f) => [f.name, f]));

  for (const required of ["Priority", "Effort", "Estimate", "ROI"]) {
    if (!fieldByName[required]) {
      throw new Error(`Project is missing the "${required}" field`);
    }
  }
  const roiField = fieldByName["ROI"];

  const itemsQuery = `
    query($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              content {
                ... on Issue { title }
                ... on PullRequest { title }
                ... on DraftIssue { title }
              }
              fieldValues(first: 30) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    number
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
          }
        }
      }
    }`;

  const items = [];
  let cursor = null;
  do {
    const page = await github.graphql(itemsQuery, { projectId: project.id, cursor });
    const conn = page.node.items;
    items.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  const updateMutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
      updateProjectV2ItemFieldValue(
        input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { number: $value } }
      ) { projectV2Item { id } }
    }`;

  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const values = {};
    for (const fv of item.fieldValues.nodes) {
      if (!fv.field) continue;
      values[fv.field.name] = fv.name !== undefined ? fv.name : fv.number;
    }

    const priorityWeight = PRIORITY_WEIGHT[values["Priority"]];
    let effortWeight = EFFORT_WEIGHT[values["Effort"]];
    if (effortWeight === undefined && typeof values["Estimate"] === "number" && values["Estimate"] > 0) {
      effortWeight = values["Estimate"];
    }

    const title = (item.content && item.content.title) || item.id;

    if (priorityWeight === undefined || effortWeight === undefined) {
      skipped++;
      core.info(`skip   ${title} (priority=${values["Priority"] ?? "-"}, effort=${values["Effort"] ?? "-"}, estimate=${values["Estimate"] ?? "-"})`);
      continue;
    }

    const roi = Math.round((priorityWeight / effortWeight) * 10 * 10) / 10;
    if (values["ROI"] === roi) {
      continue;
    }

    await github.graphql(updateMutation, {
      projectId: project.id,
      itemId: item.id,
      fieldId: roiField.id,
      value: roi,
    });
    updated++;
    core.info(`update ${title}: ROI ${values["ROI"] ?? "-"} -> ${roi}`);
  }

  core.summary
    .addHeading("Project ROI recalculation")
    .addTable([
      [{ data: "Items", header: true }, { data: "Updated", header: true }, { data: "Skipped", header: true }],
      [String(items.length), String(updated), String(skipped)],
    ])
    .write();
};
