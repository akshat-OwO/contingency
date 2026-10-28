# Public iOS login fixture

Build for the selected simulator SDK with `sh build.sh <owned-output-directory>`. The app contains only public input. It mirrors the Android login journey: enter `Public Shopper`, sign in, open account details, and return to the account.

The two extra buttons request the real notification permission and open Settings. Use these only on the fresh Session Simulator created by the proof. They exercise `ownership_unknown`; no permission is granted and no private text is supplied. The app supports portrait and landscape for the rotation proof.
