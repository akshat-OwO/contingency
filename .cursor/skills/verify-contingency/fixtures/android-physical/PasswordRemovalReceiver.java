package dev.contingency.physicalfixture;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.view.View;
import android.view.ViewGroup;

/** An ordered fixture mutation acknowledges removal without exposing any field value. */
final class PasswordRemovalReceiver extends BroadcastReceiver {
    static final String ACTION = "dev.contingency.physicalfixture.REMOVE_PASSWORD";
    private final View password;

    private PasswordRemovalReceiver(View password) {
        this.password = password;
    }

    static PasswordRemovalReceiver register(Activity activity, View password) {
        PasswordRemovalReceiver receiver = new PasswordRemovalReceiver(password);
        activity.registerReceiver(receiver, new IntentFilter(ACTION), Context.RECEIVER_EXPORTED);
        return receiver;
    }

    @Override public void onReceive(Context context, Intent intent) {
        if (ACTION.equals(intent.getAction())) {
            if (password.getParent() instanceof ViewGroup) {
                ((ViewGroup) password.getParent()).removeView(password);
            }
            setResultCode(password.getParent() == null ? 1 : 0);
        }
    }
}
