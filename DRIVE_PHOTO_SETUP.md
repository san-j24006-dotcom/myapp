# Google Drive photo upload setup

## 1. Spreadsheet columns

The current `tours` sheet columns are:

```text
id, date, endDate, destination, memo, distance, dailyDistances, mileage, photoUrl, photoUrls
```

The latest Apps Script can add missing columns automatically when saving. `date` is the start date, `endDate` is the end date, `photoUrl` is used for the cover photo, and `photoUrls` is used for additional photos.

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
