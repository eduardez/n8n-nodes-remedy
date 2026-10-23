# n8n-nodes-remedy

Community node package for the BMC Remedy ITSM API. It provides a single **Remedy** node with resource/operation selectors and a **Remedy API** credential type.

## Install

Install `n8n-nodes-remedy` in the n8n custom-node environment and restart n8n. The package requires Node.js `>=20.15`.

## Credentials

Set the base URL exactly as exposed by the deployment, for example `https://remedy.example.com/api`. The node strips trailing slashes, does not append `/api`, and accepts only HTTP(S) URLs without embedded credentials, query strings, or fragments. Supply the Remedy username and password. Unauthorized certificate acceptance defaults to off; enable it only for a trusted self-signed instance.

The credential test and node obtain a JWT with `POST <baseUrl>/jwt/login` using form-encoded credentials. The node logs in lazily on its first API call and reuses the token only for that node execution. A new execution logs in again. Tokens are not returned in node data or cached globally. Runtime login and authenticated API requests never follow redirects; configure the final API URL rather than a redirecting endpoint. Local helper operations such as queue selection and entry-ID extraction do not make an API request.

## Node inputs and outputs

The node processes input items in order. Each emitted entry, binary, or continue-on-fail error is linked to its input item. Query operations emit complete Remedy entries (including `values` and `_links`) as JSON. Empty lists and missing qualification matches emit no output item. A successful bodyless write emits a small success object; create operations return the actual API JSON body or a success object containing the response `Location` when the response has no body.

Ordinary `getMany` operations support:

- A Remedy `qualification` string, or repeatable structured `field`, `operator`, and string `value` filters; the two forms cannot be combined.
- Operators `==`, `!=`, `>`, `>=`, `<`, `<=`, and `LIKE`.
- An optional comma-separated field projection, `Limit`, and `Offset`. `Limit` defaults to `0`: `0` uses the server default; otherwise use a positive integer. Offset is non-negative.

Structured filter fields are quoted as Remedy identifiers and values as literal strings; quote and backslash characters are escaped. LIKE patterns are supplied explicitly, for example `company/%`. With no filters, the node omits `q`. Single-page reads remain the default. Opt-in **Return All** uses offset pagination with **Page Size** (default `100`) and **Max Pages** (default `100`); it continues through short pages and stops only on an empty page. The terminal empty response counts toward Max Pages. If the last allowed response is non-empty, the node errors rather than reporting incomplete results as complete. Offset pagination is not a snapshot if records change during the read.

Create and update operations accept a non-empty JSON object in **Fields JSON**. Keys are exact Remedy wire field names, not Python model attributes, and the object is not wrapped in a `values` envelope. Custom fields and `false`, `0`, and `null` values are preserved. Typed WorkInfo and helper creation operations provide their own fixed fields and reject conflicts in additional JSON.

Mutation path inputs are labeled **Entry / Request ID**. They are passed to the endpoint unchanged except for one URL-path encoding step; the node does not infer or substitute a business identifier. Query operations use the explicitly named business field. **Extract Entry ID** accepts an entry self-link (`_links.self[0].href`) or create-response `Location`, validates its same-origin/API-root entry URL, and returns the decoded `entryId`, `form`, and normalized URL without making a request. Map its `entryId` output into a mutation explicitly.

## Resources and operations

| Resource | Operations |
| --- | --- |
| `incident` | Get, Get Many, Get Assigned Incidents, Get In-Progress Incidents, Create, Update, Set Status, Assign, Resolve, Add Comment, Upload Attachment |
| `site` | Get Many |
| `siteCompanyAssociation` | Get Many |
| `people` | Get Many |
| `company` | Get, Get by Company Name, Get Many, Create, Update, Set Status |
| `workOrder` | Get, Get Many, Create, Update, Set Status, Add Comment, Get Comments, Upload Attachment |
| `task` | Get, Get Many, Create, Update, Set Status |
| `changeRequest` | Get, Get Many, Create, Update, Set Status |
| `workLog` | Get, Get Many, Create, Update, Set Status |
| `workInfo` | Get (first record for a Work Order ID), Get Many, Create Comment/WorkInfo |
| `evoServer` | Direct Get by Entry / Request ID, Get Many |
| `evoMhcPublica` | Direct Get by Entry / Request ID, Get Many |
| `attachment` | List incident attachments from HPD:WorkLog and CFG:Attachments; download a listed attachment |
| `helper` | Extract Entry ID; find open incidents by description fragments; find first open incident by exact description; get people from a site; create an enriched incident; create an enriched work order; close an alert incident; choose a queue by time |

Business-field singular lookups use Incident Number, Company Entry ID, Company name, Work Order ID, Task ID, Infrastructure Change ID, or Work Log ID as shown in their operation fields. EVO asset `Get` operations use direct entry GETs. Mutation operations retain their endpoint-specific identifier behavior; they do not perform an implicit lookup or retry with another ID.

`incident.getAssigned` and `incident.getInProgress` require an assigned group, retain their fixed status filters and source projection, and accept visible structured filters plus list paging controls. A hidden Qualification cannot override those fixed filters. Incident assignment and resolution send the Remedy field names documented by their operation parameters. Status dropdowns use the accepted values for the selected form; WorkLog status `Delete` is a status value, not an HTTP DELETE operation.

Comments create HPD:WorkLog or WOI:WorkInfo entries. WorkOrder comments can be listed from WOI:WorkInfo using the mandatory Work Order ID filter and list controls; arbitrary qualification, filters, and field projection are not applied. Attachment listing is incident-only and returns the Remedy attachment name, URL, size, source type, and available IDs. Return All pages the HPD:WorkLog and CFG:Attachments sources independently from offset zero, then emits worklog files before CFG files. A failure in either source or any page fails the listing operation.

## Binary attachments

Uploads read the selected n8n binary property through n8n's binary helper and send its bytes in multipart form data. `incident.uploadAttachment` uses an IncidentInterface multipart PUT and requires an endpoint entry ID; `workOrder.uploadAttachment` creates a WOI:WorkInfo attachment from a Work Order ID. An optional filename overrides the input binary metadata filename. EML files use the ordinary incident upload operation.

`attachment.download` accepts a URL from the listing operation, requires the configured Remedy origin and API-root path, disables redirects, and emits the content in the selected n8n binary property. It does not write to filesystem paths or forward JWT credentials to another origin. Runtime login and authenticated reads/writes also reject 3xx responses without following them.

## Remedy-only helpers

- **Find Open Incidents by Fragments** queries the assigned group, support organization, and strict `Last Modified Date > cutoff`; it then performs case-sensitive description substring matching and keeps Assigned, Pending, and In Progress records. Description Fragments must contain at least one non-blank string; whitespace inside a fragment remains significant. Return All searches pages before emitting matches.
- **Find Open Incident by Exact Description** returns the first exact-description match in those same open states. Return All scans in encounter order and stops when it finds the first open match.
- Search cutoffs subtract elapsed days and format seconds using the process-local timezone.
- **Get People from Site** selects the first enabled Site with `EVO_cs_orgid`, the first site/company association, and the first matching People record.
- **Create Enriched Incident** uses the first enabled Site → association → Company → People chain. Its visible incident option collection contains the source defaults; `Service CI` is omitted when unset. Descriptions longer than 90 Unicode code points are truncated to 85. After create, the helper waits two seconds and refetches the created incident by its returned Incident Number. A failed refetch reports that the record was already created; it does not replay the POST.
- **Create Enriched Work Order** uses the same lookup chain. `locationId` is required. Site-specific WorkOrder fields have no invented defaults and can be supplied through Fields JSON; conflicts with the eight generated WorkOrder fields are rejected. Summaries longer than 90 Unicode code points are truncated to 85.
- **Close Alert Incident** performs assign → resolve → close sequentially. It stops at the first error and reports the failed stage and completed stages. Completed stages are acknowledged successes; the failed stage may have taken effect. Verify the record before retrying. It does not roll back or retry writes.
- **Get Queue for Time** makes no Remedy API request. An optional IANA **Time Zone** selects the hour; when empty, the execution host's local timezone remains in use. With an explicit zone, a supplied Date Time must end in `Z` or a numeric offset. Hours 08:00–18:59 select `L1.AVERIAS_GP`; all other hours select `L1.7x24`. The support organization is `GESTION PERSONALIZADA`.

The helper defaults preserve observed workflow behavior and appear in the node UI. Cross-system Checkmk, NetBox, Livestatus, and email-service orchestration are not included.

## Development and verification

```sh
npm install
npm test
npm run lint
npm pack --dry-run
```

The automated tests use mocked HTTP or a local HTTP fixture and require no live Remedy credentials. A live Remedy deployment may have form-specific fields, permissions, URL roots, and validation requirements that cannot be proven offline.
