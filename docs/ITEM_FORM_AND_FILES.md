# Item form, files and image-source disclosure

This simplification keeps the existing item model and APIs. It changes grouping,
default disclosure and the item-page file presentation so routine capture stays
focused on the essentials.

## Item create/edit

The first card contains only what is needed to add an item:

1. name;
2. quantity and condition;
3. property, room and storage location, including the contextual place supplied
   by **Add items**.

Brand, model, serial number, description, category and tags are grouped in one
optional **Identity & organisation** section. Purchase, Current value and Warranty
are separate optional cards on the right (stacked on narrow screens). All optional
cards start collapsed.

![Edit form, collapsed optional sections](walkthrough/simplification2/07-after-item-form.png)

Each optional card shows a compact summary before expansion, such as
`Shared purchase · receipt linked`, `$50 per unit · $50 for 1 unit`,
`Stanley · ends 2028-02-01`, or `No warranty recorded`. Collapsed fields remain in
React state and are still submitted, so changing only the name does not clear:

- brand/model/serial/description/category/tags;
- shared purchase membership, original transaction total, receipt link or
  unknown/not-applicable purchase status;
- per-unit current value or a legacy record total and its review state;
- warranty provider, dates, reminder, notes or document link;
- existing item documents/manuals.

![Collapsed summaries with preserved purchase, value and warranty](walkthrough/simplification2/03-collapsed-summaries.png)

Expanding a section exposes the same existing fields and validation. There is no
new wizard and no confirmation step.

### Contextual Add items

The shared Add items chooser now carries both the destination and an origin back
to the source page. Manual item creation therefore keeps the room/container/
owned-storage place and after save offers **Back to** the originating room,
container or owning item.

![New item form opened from a container](walkthrough/simplification2/01-item-form-essentials.png)

## Documents & manuals

The item page now has one **Documents & manuals** surface instead of a separate
Manuals card and Documents card. It lists every attached document once, including
manuals that also appear in the manual API.

![Before: separate Manuals & help and Documents surfaces](walkthrough/simplification2/00-before-documents.png)

![After: one Documents & manuals surface](walkthrough/simplification2/08-after-documents-manuals.png)

Available actions are context-sensitive:

- empty item: one compact entry surface with Upload document, Add manual,
  Scan pages, Link existing, Find manual and Ask about this item;
- non-empty item: Upload document, Scan pages, Link existing, Library, Add manual,
  Find manual and Ask about this item;
- Link existing opens the household document library and links one existing
  receipt, warranty certificate, manual or other document without uploading a
  copy;
- Ask about this item remains available to all household roles; writes remain
  owner/member only.

Existing `Document` rows and `item_documents` links are reused. No attachment is
copied, duplicated or deleted by the merge. Manual answers still use actual stored
manual text with page/section citations. Online manual discovery still requires a
deliberately confirmed exact manufacturer/model and a configured provider; an
uploaded or linked manual does not require make/model fields. Ordinary offline
documents remain in the same library.

## Image source disclosure

Image-source labels remain honest:

- actual photo takes priority;
- reference image says whether the exact model is confirmed;
- existing AI illustration says **not a photo** and remains removable;
- category icon appears when no photo or selected image exists.

The primary line keeps concise attribution and the exact-model distinction.
License evidence, full source/image URLs, permission basis, stored dimensions,
provider/model metadata, retrieval date and technical status are inside an
accessible **Image details** disclosure. The Find/Change online image and Use icon
buttons remain visible.

![Reference image with compact source and collapsed details](walkthrough/simplification2/11-after-reference-source.png)

![Existing AI illustration details expanded](walkthrough/simplification2/10-after-image-source-details.png)

No illustration Generate/Generate another UI, AI headline control or saved summary
workflow returns. Public reference lookup remains optional and does not require a
domain list.

## Limits

- Optional sections are disclosure groups, not separate tabs or wizard steps.
- Summaries are derived from the same form state; they do not create new stored
  fields.
- Linking an existing document requires a deliberate choice. There is no automatic
  merge by title, merchant or manual text.
- Online manual discovery is still restricted to a confirmed exact model and a
  configured search provider; this change does not add a provider.
- Technical image provenance is available on demand rather than removed.
- Actual item photographs remain separate from reference/AI display images and
  document attachments.
