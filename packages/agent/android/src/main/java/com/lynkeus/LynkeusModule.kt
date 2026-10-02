package com.lynkeus

import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import org.json.JSONArray

/**
 * Touch and key synthesis dispatched to the activity's own window: no
 * instrumentation, no INJECT_EVENTS permission. Only debuggable builds get
 * it; a release build answers "unavailable" to everything.
 */
class LynkeusModule(reactContext: ReactApplicationContext) :
  NativeLynkeusSpec(reactContext) {

  private val main = Handler(Looper.getMainLooper())

  private val debuggable: Boolean
    get() = (reactApplicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  override fun isAvailable(): Boolean = debuggable

  private fun rootView(): View? = currentActivity?.window?.decorView

  private fun focusedEditText(): EditText? = rootView()?.findFocus() as? EditText

  private fun px(points: Double): Float =
    (points * reactApplicationContext.resources.displayMetrics.density).toFloat()

  private fun dispatch(down: Long, action: Int, x: Float, y: Float) {
    val root = rootView() ?: return
    val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0)
    event.source = InputDevice.SOURCE_TOUCHSCREEN
    root.dispatchTouchEvent(event)
    event.recycle()
  }

  private inline fun guarded(promise: Promise, crossinline block: () -> Unit) {
    if (!debuggable) {
      promise.reject("unavailable", "Lynkeus is only available in debuggable builds")
      return
    }
    main.post { block() }
  }

  private inline fun withFocusedInput(promise: Promise, crossinline block: (EditText) -> Unit) = guarded(promise) {
    val input = focusedEditText()
    if (input == null) {
      promise.reject("no_input", "No focused text input")
    } else {
      block(input)
      promise.resolve(true)
    }
  }

  override fun tap(x: Double, y: Double, holdMs: Double, promise: Promise) = guarded(promise) {
    if (rootView() == null) {
      promise.reject("no_window", "No activity window")
      return@guarded
    }
    val down = SystemClock.uptimeMillis()
    dispatch(down, MotionEvent.ACTION_DOWN, px(x), px(y))
    main.postDelayed({
      dispatch(down, MotionEvent.ACTION_UP, px(x), px(y))
      promise.resolve(true)
    }, if (holdMs > 0) holdMs.toLong() else 50)
  }

  override fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Double, promise: Promise) =
    guarded(promise) {
      val duration = if (durationMs > 0) durationMs else 250.0
      val down = SystemClock.uptimeMillis()
      dispatch(down, MotionEvent.ACTION_DOWN, px(x1), px(y1))
      val steps = maxOf(4, (duration / 16).toInt())
      for (i in 1..steps) {
        val t = i.toDouble() / steps
        val x = px(x1 + (x2 - x1) * t)
        val y = px(y1 + (y2 - y1) * t)
        main.postDelayed({
          dispatch(down, MotionEvent.ACTION_MOVE, x, y)
          if (i == steps) {
            dispatch(down, MotionEvent.ACTION_UP, x, y)
            promise.resolve(true)
          }
        }, (duration * t).toLong())
      }
    }

  // Editing the buffer runs the TextWatchers, so React Native sees a change.
  override fun typeText(text: String, promise: Promise) = withFocusedInput(promise) { input ->
    input.text.insert(input.selectionEnd.coerceAtLeast(0), text)
  }

  override fun deleteBackward(count: Double, promise: Promise) = withFocusedInput(promise) { input ->
    val end = input.selectionEnd.coerceAtLeast(0)
    input.text.delete((end - count.toInt()).coerceAtLeast(0), end)
  }

  // The return key sends the field's own editor action, which React Native turns into onSubmitEditing.
  override fun submitEditing(promise: Promise) = withFocusedInput(promise) { input ->
    val action = input.imeOptions and EditorInfo.IME_MASK_ACTION
    input.onEditorAction(if (action == EditorInfo.IME_ACTION_UNSPECIFIED) EditorInfo.IME_ACTION_DONE else action)
  }

  override fun dismissKeyboard(promise: Promise) = guarded(promise) {
    rootView()?.findFocus()?.clearFocus()
    promise.resolve(true)
  }

  // Synchronous: the view tree is read on whichever thread asks; reading
  // layout is safe off the main thread and this never mutates anything.
  override fun hitTest(xs: ReadableArray, ys: ReadableArray): String {
    if (!debuggable) return "[]"
    val root = rootView()
    val chains = JSONArray()
    val count = minOf(xs.size(), ys.size())
    for (i in 0 until count) {
      val chain = JSONArray()
      var view = root?.let { hitView(it, px(xs.getDouble(i)), px(ys.getDouble(i))) }
      while (view != null) {
        if (view.id > 0) chain.put(view.id)
        view = view.parent as? View
      }
      chains.put(chain)
    }
    return chains.toString()
  }

  // The deepest visible view containing the point, in window coordinates.
  private fun hitView(view: View, x: Float, y: Float): View? {
    if (view.visibility != View.VISIBLE) return null
    val location = IntArray(2)
    view.getLocationInWindow(location)
    val inside = x >= location[0] && x < location[0] + view.width && y >= location[1] && y < location[1] + view.height
    if (!inside) return null
    if (view is ViewGroup) {
      for (i in view.childCount - 1 downTo 0) {
        val hit = hitView(view.getChildAt(i), x, y)
        if (hit != null) return hit
      }
    }
    return view
  }

  companion object {
    const val NAME = NativeLynkeusSpec.NAME
  }
}
