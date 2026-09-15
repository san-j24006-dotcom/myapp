# Google Drive photo upload setup

## 1. Spreadsheet columns

The current `tours` sheet columns are:

```text
id, date, endDate, destination, memo, distance, dailyDistances, fuelEntries, fuelTotal, photoUrl, photoUrls
```

The latest Apps Script can add missing columns automatically when saving. `date` is the start date, `endDate` is the end date, `dailyDistances` stores per-day distances, `fuelEntries` stores fuel date/price/liter entries, `fuelTotal` stores the calculated fuel cost, `photoUrl` is used for the cover photo, and `photoUrls` is used for additional photos.

Older deployed scripts only save columns already present in row 1. Append missing headers to the right of existing columns; do not reorder headers without moving their data. The `deleted` sheet also needs `id` and `legacyKey` after its original three columns. GitHub updates do not update Apps Script deployments. Previously discarded dates and breakdowns must be entered again.

Each `fuelEntries` item has the shape `{"date":"2026-09-15","unitPrice":"170","liters":"10.5"}`. Entries without a date remain readable and show an unregistered date.

The frontend reuses per-tab data for 30 seconds in the same browser session and refreshes older data in the background. The reload button always fetches current data. Saving or deleting invalidates that tab's cache. With the append-only API, edits save a new revision ID before marking the old revision deleted.

## 2. Apps Script

Open the spreadsheet, then select:

```text
Extensions -> Apps Script
```

Replace the existing Apps Script code with the contents of:

```text
gas-drive-upload.js
```

The Drive folder ID is already set to:

```text
19pnCmseZGW9Oo5QaiFtsNjliOWdzGFp0
```

## 3. Deploy

In Apps Script, select:

```text
Deploy -> Manage deployments -> Edit
```

Use these settings:

```text
Execute as: Me
Who has access: Anyone
```

Then deploy or update the deployment. On the first run, approve Google Drive and spreadsheet permissions.

## 4. Organize existing photos

If photos were already uploaded before this folder structure was added, run this function once in Apps Script:

```text
organizeExistingPhotos
```

It moves existing Drive photos into category and record folders.

## 5. App behavior

After the deployment is updated:

- The cover photo upload stores one image in Google Drive.
- Additional photos can be selected together and are also stored in Google Drive.
- The spreadsheet stores only image URLs.
- Deleting a record moves its Google Drive photos to the trash.
- Removing an individual additional photo and saving also moves that photo to the trash.
- Photos are stored under category and record folders, such as `MotoLog Photos / ツーリング記録 / 2026-09-10 箱根`.
- If the new GAS upload endpoint is not ready yet, the app falls back to the previous compressed-image save method.
