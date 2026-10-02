#import "Lynkeus.h"

#import <UIKit/UIKit.h>

// Touch synthesis uses private UIKit API (the technique KIF and Detox rely
// on). Nothing below `#if DEBUG` reaches a release binary: the symbols are
// simply not compiled, so App Store review never sees them.
#if DEBUG

@interface UITouch (LynkeusPrivate)
- (void)setPhase:(UITouchPhase)phase;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)setWindow:(UIWindow *)window;
- (void)setView:(UIView *)view;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)_setIsFirstTouchForView:(BOOL)first;
@end

@interface UIEvent (LynkeusPrivate)
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_clearTouches;
@end

@interface UIApplication (LynkeusPrivate)
- (UIEvent *)_touchesEvent;
@end

static UIWindow *QaKeyWindow(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.isKeyWindow) return window;
    }
  }
  return UIApplication.sharedApplication.windows.firstObject;
}

static UITouch *QaMakeTouch(CGPoint point, UIWindow *window) {
  UITouch *touch = [[UITouch alloc] init];
  [touch setWindow:window];
  [touch _setLocationInWindow:point resetPrevious:YES];
  UIView *hit = [window hitTest:point withEvent:nil];
  [touch setView:hit ?: window];
  [touch setPhase:UITouchPhaseBegan];
  [touch setTapCount:1];
  [touch _setIsFirstTouchForView:YES];
  [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
  return touch;
}

static void QaSend(UITouch *touch, UITouchPhase phase, CGPoint point) {
  [touch _setLocationInWindow:point resetPrevious:NO];
  [touch setPhase:phase];
  [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
  UIEvent *event = [UIApplication.sharedApplication _touchesEvent];
  [event _clearTouches];
  [event _addTouch:touch forDelayedDelivery:NO];
  [UIApplication.sharedApplication sendEvent:event];
}

// UIKit resets gesture recognizers only once the run loop turns after a
// touch sequence ends. A new touch that begins before that reset lands in a
// recognizer whose registry is then wiped, and React Native's touch handler
// asserts on the orphaned Ended. Handing control back keeps taps distinct.
static void QaAfterSequence(RCTPromiseResolveBlock resolve) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.03 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    resolve(@YES);
  });
}

static UIView *QaFirstResponder(UIView *view) {
  if (view.isFirstResponder) return view;
  for (UIView *child in view.subviews) {
    UIView *found = QaFirstResponder(child);
    if (found) return found;
  }
  return nil;
}

static id<UIKeyInput> QaKeyInput(void) {
  UIView *responder = QaFirstResponder(QaKeyWindow());
  return [responder conformsToProtocol:@protocol(UIKeyInput)] ? (id<UIKeyInput>)responder : nil;
}

#endif

@implementation Lynkeus

- (NSNumber *)isAvailable
{
#if DEBUG
  return @YES;
#else
  return @NO;
#endif
}

- (void)tap:(double)x y:(double)y holdMs:(double)holdMs
    resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = QaKeyWindow();
    if (!window) return reject(@"no_window", @"No key window", nil);
    CGPoint point = CGPointMake(x, y);
    UITouch *touch = QaMakeTouch(point, window);
    QaSend(touch, UITouchPhaseBegan, point);
    double hold = holdMs > 0 ? holdMs : 50;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(hold / 1000.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      QaSend(touch, UITouchPhaseEnded, point);
      QaAfterSequence(resolve);
    });
  });
#else
  reject(@"unavailable", @"Lynkeus touch synthesis is compiled out of release builds", nil);
#endif
}

- (void)swipe:(double)x1 y1:(double)y1 x2:(double)x2 y2:(double)y2 durationMs:(double)durationMs
      resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = QaKeyWindow();
    if (!window) return reject(@"no_window", @"No key window", nil);
    CGPoint from = CGPointMake(x1, y1), to = CGPointMake(x2, y2);
    UITouch *touch = QaMakeTouch(from, window);
    QaSend(touch, UITouchPhaseBegan, from);
    double duration = durationMs > 0 ? durationMs : 250;
    NSInteger steps = MAX(4, (NSInteger)(duration / 16.0));
    double stepSeconds = (duration / 1000.0) / steps;
    for (NSInteger i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      CGPoint p = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(stepSeconds * i * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        QaSend(touch, UITouchPhaseMoved, p);
        if (i == steps) {
          QaSend(touch, UITouchPhaseEnded, p);
          QaAfterSequence(resolve);
        }
      });
    }
  });
#else
  reject(@"unavailable", @"Lynkeus touch synthesis is compiled out of release builds", nil);
#endif
}

- (void)typeText:(NSString *)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    id<UIKeyInput> input = QaKeyInput();
    if (!input) return reject(@"no_input", @"No focused text input", nil);
    [text enumerateSubstringsInRange:NSMakeRange(0, text.length)
                             options:NSStringEnumerationByComposedCharacterSequences
                          usingBlock:^(NSString *ch, NSRange r, NSRange er, BOOL *stop) {
      [input insertText:ch];
    }];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus key synthesis is compiled out of release builds", nil);
#endif
}

- (void)deleteBackward:(double)count resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    id<UIKeyInput> input = QaKeyInput();
    if (!input) return reject(@"no_input", @"No focused text input", nil);
    for (NSInteger i = 0; i < (NSInteger)count; i++) [input deleteBackward];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus key synthesis is compiled out of release builds", nil);
#endif
}

- (void)dismissKeyboard:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    [QaFirstResponder(QaKeyWindow()) resignFirstResponder];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus is compiled out of release builds", nil);
#endif
}

// A single-line field submits through its delegate, which is where the return
// key lands; a multi-line one sees the newline and decides by submitBehavior.
- (void)submitEditing:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
#if DEBUG
  dispatch_async(dispatch_get_main_queue(), ^{
    UIResponder *responder = QaFirstResponder(QaKeyWindow());
    if ([responder isKindOfClass:[UITextField class]]) {
      UITextField *field = (UITextField *)responder;
      BOOL leaves = YES;
      if ([field.delegate respondsToSelector:@selector(textFieldShouldReturn:)]) leaves = [field.delegate textFieldShouldReturn:field];
      // What UIKit does after the key when the delegate agrees: end editing and give up the keyboard.
      if (leaves) {
        [field sendActionsForControlEvents:UIControlEventEditingDidEndOnExit];
        [field resignFirstResponder];
      }
      return resolve(@YES);
    }
    id<UIKeyInput> input = QaKeyInput();
    if (!input) return reject(@"no_input", @"No focused text input", nil);
    [input insertText:@"\n"];
    resolve(@YES);
  });
#else
  reject(@"unavailable", @"Lynkeus key synthesis is compiled out of release builds", nil);
#endif
}

// Synchronous: called on the JS thread, hit-tests on the main thread and
// waits. UIKit's hitTest is cheap, so this is microseconds per point.
- (NSString *)hitTest:(NSArray *)xs ys:(NSArray *)ys
{
#if DEBUG
  __block NSString *result = @"[]";
  void (^work)(void) = ^{
    UIWindow *window = QaKeyWindow();
    if (!window) return;
    NSUInteger count = MIN(xs.count, ys.count);
    NSMutableArray *chains = [NSMutableArray arrayWithCapacity:count];
    for (NSUInteger i = 0; i < count; i++) {
      CGPoint p = CGPointMake([xs[i] doubleValue], [ys[i] doubleValue]);
      UIView *view = [window hitTest:p withEvent:nil];
      NSMutableArray<NSNumber *> *chain = [NSMutableArray array];
      while (view) {
        if (view.tag > 0) [chain addObject:@(view.tag)];
        view = view.superview;
      }
      [chains addObject:chain];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:chains options:0 error:nil];
    result = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  };
  if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
  return result;
#else
  return @"[]";
#endif
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeLynkeusSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"Lynkeus";
}

@end
