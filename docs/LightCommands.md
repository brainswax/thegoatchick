## Lights

### Listing Available Lights
To get a list of available lights:
```shell
!lights

parlor, loft, kids
```

### Turning Lights On and Off
To turn a light on:
```shell
!parlor on
```

To turn a light off:
```shell
!parlor off
```
### Dimming Lights
To dim a light to 50% brightness:
```shell
!parlor 50
```

To dim a light 10% from the current value:
```shell
!parlor -10
```

To brighten a light 10% from the current value:
```shell
!parlor +10
```

### Changing the Color of Lights
To change the RGB color of a light:

```shell
!parlor 0xFFFFFF
```

To change a light to a named color
```shell
!parlor red
```

The pre-defined colors are: red, orange, yellow, green, blue, purple, white

### Saving a Light Setting

To name the current light setting or update an existing light setting:
```shell
!parlor save:night
```
Note that this also overrides the previous value. Naming a dim level will allow it to be used by other lights.

To set another light to the previously save dim level:
```shell
!loft night
```
