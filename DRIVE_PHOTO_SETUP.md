# Google Drive photo upload setup

## 1. Spreadsheet columns

In the `tours` sheet, add this header at the end of the first row:

```text
photoUrls
```

`photoUrl` is used for the cover photo. `photoUrls` is used for additional photos.

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

## 4. App behavior

After the deployment is updated:

- The cover photo upload stores one image in Google Drive.
- Additional photos can be selected together and are also stored in Google Drive.
- The spreadsheet stores only image URLs.
- Deleting a record moves its Google Drive photos to the trash.
- Removing an individual additional photo and saving also moves that photo to the trash.
- If the new GAS upload endpoint is not ready yet, the app falls back to the previous compressed-image save method.
