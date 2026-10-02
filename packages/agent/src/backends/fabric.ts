import { Dimensions } from 'react-native';

import { type Backend, centre } from '../backend';
import { touch } from '../native';
import { commitCount, debugTree, pressHandlerFor, snapshotElements, trackCommits } from '../tree';

/** The app on a device or simulator: fiber tree + Fabric measurement + native touches. */
export const fabricBackend = (): Backend => {
  trackCommits();
  const pressPoint = async (x: number, y: number, holdMs: number) => {
    await touch.tap(x, y, holdMs);
  };
  return {
    name: 'fabric',
    get native() {
      return touch.available();
    },
    snapshot: snapshotElements,
    commitCount,
    window: () => {
      const { width, height } = Dimensions.get('window');
      return { w: width, h: height };
    },
    press: (element, holdMs) => {
      const { x, y } = centre(element);
      return pressPoint(x, y, holdMs);
    },
    pressPoint,
    pressJs: async (element) => {
      if (!element.testId) throw new Error('mode "js" needs a target with a testId');
      const handler = pressHandlerFor(element.testId);
      if (!handler) throw new Error(`No onPress behind #${element.testId}`);
      const { x, y } = centre(element);
      handler({ nativeEvent: { pageX: x, pageY: y, locationX: 0, locationY: 0 } });
    },
    typeText: async (text) => {
      await touch.typeText(text);
    },
    deleteBackward: async (count) => {
      await touch.deleteBackward(count);
    },
    dismissKeyboard: async () => {
      await touch.dismissKeyboard();
    },
    submit: async () => {
      await touch.submitEditing();
    },
    swipe: async (from, to, durationMs) => {
      await touch.swipe(from.x, from.y, to.x, to.y, durationMs);
    },
    debug: debugTree,
  };
};
