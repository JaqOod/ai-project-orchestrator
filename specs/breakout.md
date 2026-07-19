# Breakout

A classic Breakout game on the provided 400x400 canvas.

## Rules
- A paddle (60x10, light color) sits near the bottom, moved with ArrowLeft/ArrowRight; it never leaves the canvas.
- A ball (radius 5) starts on the paddle; Space launches it up at an angle. The ball bounces off the left/right/top walls and off the paddle; where it hits the paddle changes the bounce angle (edge hits deflect more sharply).
- 5 rows x 8 columns of bricks across the top, each 44x14 with small gaps; each row a different color. A brick disappears when the ball hits it, and the ball bounces.
- Score: +10 per brick, shown in the #ui div as "Score: N   Lives: M".
- 3 lives. If the ball falls below the bottom, lose a life and the ball resets onto the paddle (launch again with Space).
- Win when all bricks are cleared ("YOU WIN" centered on the canvas); lose at 0 lives ("GAME OVER"). Enter restarts the game in either end state.

## Feel
- Game loop via requestAnimationFrame, ball speed ~3.5 px/frame, dark background.
