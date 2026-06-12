# Scheduled scan at 1am Friday, no manual trigger in the dashboard

Estate sales follow a weekly cycle — listings post Thursday/Friday, sales run Friday–Sunday. The dashboard is a read interface for Friday morning browsing, not a control panel. A macOS LaunchAgent triggers the scan at 1am Friday (GPU free after 12:30am); results are ready when the user wakes up. Removing the scan trigger from the UI eliminates a class of accidental data loss (new scan wiping prior cities' findings) and keeps the interface focused on browsing.
