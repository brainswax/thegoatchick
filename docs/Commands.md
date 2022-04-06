# Chat commands
## Anyone Commands
| Command | Description |
| :--     | :-- |
| _!cams_ | Lists the available cams for the current scene |
| _!ptz_  | Lists all of the controllable PTZ cams available (regardless of scene) |

## Subscriber Commands
| Command        | Description |
| :--            | :-- |
| _!scenes_      | Lists the available scenes |
| _!scene_       | Sets which scene is in view |
| _!cam_         | Sets which cameras are in view |
| _!camera_      | Alias for !cam |
| _!bell_        | Puts the bell camera in view and moves to shortcut 'bell' |
| _!\[cam name]_ | Change the zoom or position of a cam or shows information about the cam |
| _!cam\[N]_     | Move or resize the camera view for a specified window |

## Moderator Commands
| Command          | Description |
| :--              | :-- |
| _!sync_          | Query obs and force update the current sources as well as set the view positions and sizes |
| _!log_           | Sets the log level for the various log outputs |
| _!admin_         | Adds a user as an admin with moderator permissions without needing a Moderator role in twitch |
| _!mute_          | Mute the stream audio |
| _!unmute_        | Unmute the stream audio |
| _!restartscript_ | Restart the controller script |
| _!stop_          | Stop the stream |
| _!start_         | Start the stream |
| _!restart_       | Restart the stream |

# Scenes
To get the list of available scenes:

```
!scenes
scenes: 1-cam, 3-cam
```

To change scenes:
```
!scene 1-cam
```

# Cameras
## Changing Cameras
To get the list of available cams:

```
!cams
Available cams: does (ptz), parlor (ptz), yard (ptz), kiddinga, kiddingb, nursery
```

The camera views can be change one or many at a time. For example, this will set the main camera to 'does', the cam in window 1 as 'yard', and the cam in window 2 as 'parlor':
```
!cam does 1yard 2parlor
```
## Moving PTZ Cameras
The PTZ (Pan-Tilt-Zoom) cameras can be controlled by subscribers in chat. To get a list of PTZ cameras:
```
!ptz
PTZ cams: does, parlor, yard
```

The following sub-commands can be used to move the cameras:
| Command        | Description                                                  | Example |
| :--            | :--                                                          | :-- |
| \[u, up][N]    | Move the camera up from the current position by N degrees    | !does u10 |
| \[d, down][N]  | Move the camera down from the current position by N degrees  | !does d10 |
| \[t, tilt][N]  | Tilt the camera to an absolute value N (0-90 degrees)        | !does t60 |
| \[l, left][N]  | Move the camera left from the current position by N degrees  | !does l10 |
| \[r, right][N] | Move the camera right from the current position by N degrees | !does r10 |
| \[p, pan][N]   | Pan the camera to an absolute value N (0-360 degrees)        | !does p180 |
| \[i, in][N]    | Zoom in N percent from the current zoom                      | !does i10 |
| \[o, out][N]   | Zoom out N percent from the current zoom                     | !does o10 |
| \[z, zoom][N]  | Zoom to an absolute value N (0 to 100%)                      | !does z100 |

These sub-commands can also be stringed together into a single command:
```
!does u10 l5 z50
```

They can also be used with shortcuts and will be applied in order. For example, this will zoom in 50% and tilt 20 degrees above the feeder shortcut:
```
!does feeder u20 z50
```

This also works with saving shortcuts, which will save a shortcut at the position the camera is in when it processes the save command:
```
!does feeder u20 z50 save:wall
```

This will move the camera, save the shortcut 'wall' in the same position as above, but then move the camera right further:
```
!does feeder u20 z50 save:wall r20
```

## Camera Shortcuts
Camera shortcuts can be used to move the camera to named positions (and zoom) for each individual camera. To get the shortcuts associated with a cam:

```
!does info
does shortcuts: feeder, door, butch, bucks, center, joules, water, gate, honey, island
```

To move the camera to a particular shortcut:
```
!does feeder
```

To add a new shortcut or update an existing one with the current camera position:
```
!does save:feeder
```

To remove a shortcut:
```
!does delete:feeder
```

To show the position and zoom of a particular shortcut:
```
!does info:feeder
feeder pan: 135, tilt: 67, zoom: 0
```

# Views
A view or window refers to the viewable cameras locations or frames in the current scene. The views are referenced by numbers which are picked automatically based on their size and position in the scene and start from 0, 1, ... N. The largest view will be considered cam0, then numbered based on the closest to the origin.

The top left corner is considered the origin. All positions refer to the top left corner of the camera source.

To see the current position and size of a view:
```
!cam0 info
cam0 x:57 y:73 w:1328 h:747
```

The following sub-commands can be used to change the position and/or size of a view:
| Command          | Description                                                                | Example |
| :--              | :--                                                                        | :-- |
| x:\[N]           | Move the view to an absolute position N pixels from the left of the origin | !cam0 x:10 |
| y:\[N]           | Move the view to an absolute position N pixels down from the origin        | !cam0 y:10 |
| \[h, height]:[N] | Change the hight of a view to N pixels                                     | !cam0 h:720 |
| \[w, width]:[N]  | Change the width of a view to N pixels                                     | !cam0 w:1280 |

These sub-commands can also be stringed together into a single command:
```
!cam0 x:0 y:180 h:720 w:1280
```

If the view dimensions don't match the source camera dimensions, the camera will be stretched to fit into the view dimensions.

# Logs
The script supports multiple log outputs, which can be configured individually. The log levels are standard syslog levels and setting it will include all logs of a particular severity and higher. From highest to lowest:

| Log Severity Level | Description |
| :--                | :-- |
| error              | Error condition |
| warn               | A warning that could indicate an error will or may have occurred |
| info               | Information message that require no action |
| debug              | Verbose information used to debug the application |

Currently there are only two log outputs supported: console and slack.

To change the log level of one of the log outputs:
```
!log slack:debug
```

To change the log level of multiple log outputs:
```
!log slack:info console:debug
```
