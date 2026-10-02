import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Button, Text, TextInput, View } from 'react-native';
import { Lynkeus, qa, reactNavigationAdapter } from 'lynkeus-agent';

const Stack = createNativeStackNavigator();

const Home = ({ navigation }: { navigation: { navigate: (r: string) => void } }) => (
  <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
    <Text testID="title">Hello, agent</Text>
    <TextInput testID="name-input" placeholder="Your name" style={{ borderWidth: 1, padding: 8 }} />
    <Button testID="next-button" title="Next" onPress={() => navigation.navigate('Details')} />
  </View>
);

const Details = () => (
  <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
    <Text testID="details">Details</Text>
  </View>
);

qa.register('reset', () => {
  /* clear session, caches, preferences */
});

export default function App() {
  const ref = useNavigationContainerRef();
  return (
    <NavigationContainer ref={ref}>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Details" component={Details} />
      </Stack.Navigator>
      <Lynkeus navigation={reactNavigationAdapter(ref)} app={{ name: 'example' }} />
    </NavigationContainer>
  );
}
