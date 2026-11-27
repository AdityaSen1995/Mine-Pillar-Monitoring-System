# Mine Pillar Monitoring System — GitHub Pages edition

This folder contains a browser version of the Jupyter notebook. It uses HTML, CSS and JavaScript so GitHub Pages can serve it. GitHub Pages does not run a Python notebook or Python back end; the CSV calculations run locally in the visitor's browser instead. [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)

## Publish on GitHub Pages

1. Create a new GitHub repository. Make it public if you want to use GitHub Free Pages.
2. Upload the contents of this folder (`index.html`, `app.js`, `styles.css`, and `.nojekyll`) to the repository root and commit them to the `main` branch.
3. Open the repository's **Settings → Pages**.
4. Under **Build and deployment**, select **Deploy from a branch**, choose **main** and **/(root)**, then save.
5. Wait for the Pages deployment to complete. Open the URL shown in **Settings → Pages**. It will usually be `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

The app code and supplied CSV contents are not sent to a Python server: files are read in the browser. The map downloads satellite tiles from Google, so the map, libraries, and tile service require internet access. The app itself does not store uploaded CSVs. If an external library is temporarily blocked, the file chooser still works; refresh after restoring internet access to calculate and display the map.

## Data format

CSV headings: `ID`, `Date`, `Easting`, `Northing`, and optionally `Elevation`. Dates must be `dd-mm-yyyy`; coordinates must use WGS84 / UTM Zone 45N, matching the notebook settings. If comparing past and present surveys, provide elevation in both files or neither. Select only a present CSV to show new pillars in pink.

Snapshot and report buttons trigger browser downloads. Depending on browser settings, downloads may go straight to the Downloads folder instead of opening a Save As dialog.

## Files

- `index.html`: page structure and browser library references.
- `styles.css`: notebook-matching controls and responsive layout.
- `app.js`: CSV parsing, displacement calculations, map layers and browser exports.
- `.nojekyll`: tells Pages to serve all static assets as-is.
