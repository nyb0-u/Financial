function setupAutocatatSheet() {
  const spreadsheetId = "1UsdMPEhEaBVWVTGywkfgbVnVzCCsGBWGhM8gOGGGQeU";
  const tabName = "Transaksi";
  const headers = ["Tanggal", "Jenis", "Deskripsi", "Kategori", "Sumber Dana", "Jumlah", "Akun ID", "Mata Uang"];

  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  let sheet = spreadsheet.getSheetByName(tabName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(tabName);
  }

  const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  const rowIsEmpty = currentHeaders.every((value) => value.trim() === "");
  const headersMatch = headers.every((header, index) => currentHeaders[index].trim() === header);
  const legacySevenHeadersMatch = headers.slice(0, 7).every((header, index) => currentHeaders[index].trim() === header) &&
    currentHeaders[7].trim() === "";
  const legacySixHeadersMatch = headers.slice(0, 6).every((header, index) => currentHeaders[index].trim() === header) &&
    currentHeaders[6].trim() === "" && currentHeaders[7].trim() === "";

  if (rowIsEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (legacySevenHeadersMatch) {
    sheet.getRange(1, 8).setValue(headers[7]);
  } else if (legacySixHeadersMatch) {
    sheet.getRange(1, 7, 1, 2).setValues([[headers[6], headers[7]]]);
  } else if (!headersMatch) {
    throw new Error(
      'Baris pertama tab "' +
        tabName +
        '" sudah berisi header/data yang berbeda. Tidak ada data yang diubah. Periksa baris pertama sebelum menjalankan ulang.',
    );
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight("bold")
    .setBackground("#182238")
    .setFontColor("#ffffff");
  sheet.getRange("A:A").setNumberFormat("yyyy-mm-dd");
  sheet.getRange("F:F").setNumberFormat("#,##0.00");
  sheet.setColumnWidth(1, 115);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 240);
  sheet.setColumnWidth(4, 190);
  sheet.setColumnWidth(5, 145);
  sheet.setColumnWidth(6, 135);
  sheet.setColumnWidth(7, 255);
  sheet.setColumnWidth(8, 110);

  if (!sheet.getFilter()) {
    sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), headers.length).createFilter();
  }

  SpreadsheetApp.flush();
  console.log('Tab "' + tabName + '" siap di spreadsheet "' + spreadsheet.getName() + '".');
}
