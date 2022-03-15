# Hue Bridge Lights
Read the [Getting Started](https://developers.meethue.com/develop/get-started-2/) article on the Hue Developer site for specific details on how to discover, authenticate, and manage lights manually through a web browser.

## Discovery
A Hue bridge is a discoverable device that acts as a central API to control individual smart lights in your local network. It uses [SSDP](https://en.wikipedia.org/wiki/Simple_Service_Discovery_Protocol) over UDP for local broadcast discovery. If your Hue Bridge has already been setup in your network, you can also find the IP address through your mobile app.

Once the local address is discovered, the bridge can be contacted via an HTTPS service through a browser, Postman, or any other web-based tool or script.

## API
The HUE bridge API uses a simple (insecure) authentication mechanism, which is basically the equivalent of signing in at the front desk. You give it your name and it returns an identifying key for you to use. That key is able to control your lights indefinitely so long as the user is not deleted from the bridge.

## Color
The lights use a Hue, Saturation, Brightness ([HSB](https://learnui.design/blog/the-hsb-color-system-practicioners-primer.html)) color system for setting the color and brightness of lights.
